import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import pino from 'pino';
import qrcodeTerminal from 'qrcode-terminal';
import { createClient } from '@supabase/supabase-js';
import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    downloadMediaMessage
} from '@whiskeysockets/baileys';

dotenv.config();

const PORT = process.env.PORT || 5000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error("❌ Missing Supabase credentials in .env");
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const app = express();
app.use(cors());
app.use(express.json());

let waSock = null;
let qrCodeData = null;
let isConnected = false;
let botUserJid = null;

// Helper: Clean & format phone numbers to standard WhatsApp format
function formatJid(phone) {
    if (!phone) return null;
    let cleaned = phone.replace(/\D/g, ''); // Remove non-numeric characters
    if (cleaned.startsWith('00')) {
        cleaned = cleaned.substring(2);
    }
    // If UAE number starting with 05..., add 971 prefix
    if (cleaned.startsWith('05') && cleaned.length === 10) {
        cleaned = '971' + cleaned.substring(1);
    }
    // If Pakistan number starting with 03..., add 92 prefix
    if (cleaned.startsWith('03') && cleaned.length === 11) {
        cleaned = '92' + cleaned.substring(1);
    }
    return `${cleaned}@s.whatsapp.net`;
}

async function resolveJid(phone) {
    if (!phone) return null;
    let jid = formatJid(phone);
    if (waSock && isConnected) {
        try {
            const clean = jid.split('@')[0];
            const results = await waSock.onWhatsApp(clean);
            if (results && results.length > 0 && results[0].exists) {
                return results[0].jid;
            }
        } catch (e) {
            console.log('onWhatsApp check warning:', e.message);
        }
    }
    return jid;
}

// Start Baileys WhatsApp Bot
async function startWhatsAppBot() {
    const logger = pino({ level: 'silent' });
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    console.log(`🤖 Initializing WhatsApp Baileys Bot (v${version.join('.')})...`);

    waSock = makeWASocket({
        version,
        logger,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger)
        },
        printQRInTerminal: false,
        browser: ['Deserts System Bot', 'Chrome', '1.0.0']
    });

    waSock.ev.on('creds.update', saveCreds);

    waSock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrCodeData = qr;
            isConnected = false;
            console.log('\n==================================================');
            console.log('📱 SCAN THIS QR CODE WITH YOUR WHATSAPP TO CONNECT:');
            console.log('==================================================\n');
            qrcodeTerminal.generate(qr, { small: true });
            console.log(`\n💡 Or open http://localhost:${PORT}/qr in your web browser!`);
        }

        if (connection === 'open') {
            isConnected = true;
            qrCodeData = null;
            botUserJid = waSock.user?.id;
            console.log('✅ WHATSAPP BOT CONNECTED SUCCESSFULLY!');
            console.log(`👤 Connected JID: ${botUserJid}`);
        }

        if (connection === 'close') {
            isConnected = false;
            botUserJid = null;
            qrCodeData = null;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut && statusCode !== 401;
            console.log(`⚠️ Connection closed (reason code: ${statusCode}). Reconnecting: ${shouldReconnect}`);

            if (shouldReconnect) {
                setTimeout(startWhatsAppBot, 3000);
            } else {
                console.log('❌ Logged out or session expired. Clearing old auth credentials to regenerate fresh QR code...');
                try {
                    import('fs').then(fs => {
                        if (fs.existsSync('./auth_info_baileys')) {
                            fs.rmSync('./auth_info_baileys', { recursive: true, force: true });
                        }
                    });
                } catch (e) {
                    console.error('Error clearing auth directory:', e);
                }
                setTimeout(startWhatsAppBot, 2000);
            }
        }
    });

    // Listen for Incoming WhatsApp Messages
    waSock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg || !msg.message || msg.key.fromMe) return; // Skip if no message or sent by bot

            const remoteJid = msg.key.remoteJid;
            if (!remoteJid || remoteJid.endsWith('@g.us')) return; // Ignore group chats

            let mediaUrl = null;
            let incomingText = '';

            // Handle Incoming Image Message
            if (msg.message.imageMessage) {
                try {
                    const buffer = await downloadMediaMessage(msg, 'buffer', {});
                    const mime = msg.message.imageMessage.mimetype || 'image/jpeg';
                    mediaUrl = `data:${mime};base64,${buffer.toString('base64')}`;
                    incomingText = msg.message.imageMessage.caption || '📷 Photo';
                    console.log(`📷 Received incoming photo from ${remoteJid}`);
                } catch (err) {
                    console.error('Error downloading incoming image:', err);
                    incomingText = '📷 Photo';
                }
            } else {
                incomingText = msg.message.conversation ||
                    msg.message.extendedTextMessage?.text ||
                    msg.message.buttonsResponseMessage?.selectedButtonId ||
                    msg.message.listResponseMessage?.singleSelectReply?.selectedRowId || '';
            }

            if (!incomingText && !mediaUrl) return;

            const cleanPhone = remoteJid.split('@')[0].split(':')[0].replace(/\D/g, '');
            const last8 = cleanPhone.length >= 8 ? cleanPhone.slice(-8) : cleanPhone;
            console.log(`💬 Incoming WhatsApp from ${cleanPhone} (${remoteJid}): "${incomingText}"`);

            // 1. Find matching chat in Supabase by phone_number
            let { data: existingChat } = await supabase
                .from('whatsapp_chats')
                .select('*')
                .or(`phone_number.eq.${cleanPhone},phone_number.like.%${last8}%`)
                .order('last_message_at', { ascending: false })
                .limit(1)
                .maybeSingle();

            // 2. If no direct phone match (e.g. WhatsApp LID number @lid), match recent active chat
            if (!existingChat) {
                const { data: recentActiveChat } = await supabase
                    .from('whatsapp_chats')
                    .select('*')
                    .order('last_message_at', { ascending: false })
                    .limit(1)
                    .maybeSingle();

                if (recentActiveChat) {
                    console.log(`🔗 Matched LID message to recent active chat ID ${recentActiveChat.id}`);
                    existingChat = recentActiveChat;
                }
            }

            let chatId = existingChat?.id;
            let orderId = existingChat?.order_id;
            let orderNumber = null;

            if (orderId) {
                const { data: ord } = await supabase
                    .from('orders')
                    .select('order_number')
                    .eq('id', orderId)
                    .maybeSingle();
                if (ord) orderNumber = ord.order_number;
            }

            // 3. If no existing chat found, search recent order by customer_phone
            if (!existingChat && cleanPhone) {
                const { data: orderData } = await supabase
                    .from('orders')
                    .select('*')
                    .or(`customer_phone.eq.${cleanPhone},customer_phone.like.%${last8}%`)
                    .order('created_at', { ascending: false })
                    .limit(1)
                    .maybeSingle();

                if (orderData) {
                    orderId = orderData.id;
                    orderNumber = orderData.order_number;
                    const { data: newChat } = await supabase
                        .from('whatsapp_chats')
                        .insert({
                            order_id: orderData.id,
                            phone_number: cleanPhone,
                            customer_name: orderData.customer_name || 'Customer',
                            last_message: incomingText,
                            last_message_at: new Date().toISOString(),
                            has_unread: true,
                            unread_count: 1
                        })
                        .select()
                        .single();
                    chatId = newChat?.id;
                }
            } else if (existingChat) {
                // Update existing chat's last message & set unread flags
                const currentUnread = existingChat.unread_count || 0;
                await supabase
                    .from('whatsapp_chats')
                    .update({
                        last_message: incomingText,
                        last_message_at: new Date().toISOString(),
                        has_unread: true,
                        unread_count: currentUnread + 1
                    })
                    .eq('id', chatId);
            }

            // Fallback: If still no chatId, create chat record so message is never lost
            if (!chatId) {
                const { data: newChat } = await supabase
                    .from('whatsapp_chats')
                    .insert({
                        order_id: orderId || null,
                        phone_number: cleanPhone,
                        customer_name: 'Customer',
                        last_message: incomingText,
                        last_message_at: new Date().toISOString(),
                        has_unread: true,
                        unread_count: 1
                    })
                    .select()
                    .single();
                chatId = newChat?.id;
            }

            // Save incoming message (Text or Image) in database
            if (chatId) {
                await supabase.from('whatsapp_messages').insert({
                    chat_id: chatId,
                    order_id: orderId || null,
                    sender: 'customer',
                    message_type: mediaUrl ? 'image' : 'text',
                    message_text: incomingText,
                    media_url: mediaUrl,
                    status: 'received'
                });
                console.log(`✅ Saved incoming customer reply to chat ID ${chatId}`);
            }

            // SMART CONFIRMATION & CANCELLATION KEYWORDS
            const lowerText = incomingText.trim().toLowerCase();

            // Include common spelling variations & typos (e.g., 'confrim' as seen in screenshot)
            const confirmKeywords = ['confirm', 'confrim', 'confrm', 'comfirm', 'comfrim', 'confirmed', 'confrimed', 'yes', 'ok', 'okay', '1', 'ha', 'ji'];
            const cancelKeywords = ['cancel', 'cancle', 'canceled', 'cancelled', 'cancled', '2', 'no', 'nahi', 'nhi'];

            const isConfirm = confirmKeywords.some(k => lowerText.includes(k));
            const isCancel = cancelKeywords.some(k => lowerText.includes(k));

            if (isConfirm && orderId) {
                console.log(`🎯 Order #${orderNumber || orderId} confirmed by customer WhatsApp reply!`);

                await supabase.from('orders').update({
                    status: 'confirmed',
                    status_updated_at: new Date().toISOString()
                }).eq('id', orderId);

                await supabase.from('order_tracking').insert({
                    order_id: orderId,
                    status: 'Confirmed'
                });

                if (chatId) {
                    await supabase.from('whatsapp_chats').update({ status: 'confirmed' }).eq('id', chatId);
                }

                const replyText = `✅ Your order #${orderNumber || ''} has been *Confirmed*. We are preparing it for shipment. Thank you!`;

                await waSock.sendMessage(remoteJid, { text: replyText });

                if (chatId) {
                    await supabase.from('whatsapp_messages').insert({
                        chat_id: chatId,
                        order_id: orderId,
                        sender: 'bot',
                        message_type: 'status_update',
                        message_text: replyText,
                        status: 'sent'
                    });
                }
            } else if (isCancel && orderId) {
                console.log(`❌ Order #${orderNumber || orderId} cancelled by customer WhatsApp reply!`);

                await supabase.from('orders').update({
                    status: 'cancelled',
                    status_updated_at: new Date().toISOString()
                }).eq('id', orderId);

                await supabase.from('order_tracking').insert({
                    order_id: orderId,
                    status: 'Cancelled'
                });

                if (chatId) {
                    await supabase.from('whatsapp_chats').update({ status: 'cancelled' }).eq('id', chatId);
                }

                const replyText = `❌ Your order #${orderNumber || ''} has been *Cancelled*. If this was a mistake, please let us know. Thank you!`;

                await waSock.sendMessage(remoteJid, { text: replyText });

                if (chatId) {
                    await supabase.from('whatsapp_messages').insert({
                        chat_id: chatId,
                        order_id: orderId,
                        sender: 'bot',
                        message_type: 'status_update',
                        message_text: replyText,
                        status: 'sent'
                    });
                }
            } else if (!isConfirm && !isCancel) {
                // Intelligent AI Customer Support Auto-Reply
                let activeOrder = null;
                if (orderId) {
                    const { data: o } = await supabase
                        .from('orders')
                        .select('*, products(name)')
                        .eq('id', orderId)
                        .maybeSingle();
                    activeOrder = o;
                }

                const aiReplyText = generateAICustomerResponse(incomingText, activeOrder);
                console.log(`🤖 AI Auto-Reply to ${remoteJid}: "${aiReplyText}"`);

                await waSock.sendMessage(remoteJid, { text: aiReplyText });

                if (chatId) {
                    await supabase.from('whatsapp_messages').insert({
                        chat_id: chatId,
                        order_id: orderId || null,
                        sender: 'bot',
                        message_type: 'text',
                        message_text: aiReplyText,
                        status: 'sent'
                    });

                    await supabase.from('whatsapp_chats').update({
                        last_message: aiReplyText,
                        last_message_at: new Date().toISOString()
                    }).eq('id', chatId);
                }
            }
        } catch (err) {
            console.error('Error handling incoming WhatsApp message:', err);
        }
    });
}

// AI Customer Support Response Generator
function generateAICustomerResponse(incomingText, order) {
    const text = (incomingText || '').toLowerCase().trim();
    const customerName = order?.customer_name || 'Valued Customer';
    const orderNum = order?.order_number || (order?.id ? order.id.slice(0, 6) : 'N/A');
    const productName = order?.products?.name || 'your product';
    const amount = order?.cod_amount || order?.payable_amount || 0;
    const city = order?.city || order?.emirate || 'UAE';
    const status = order?.status || 'Pending';

    // Intent 1: Greetings
    if (/^(hi|hello|hey|slam|salam|hola|good morning|good evening|aoa)/.test(text)) {
        return `Hello ${customerName}! 👋 Thank you for contacting Deserts. How can we assist you with order #${orderNum} (${productName}) today?`;
    }

    // Intent 2: Delivery & Shipping Status
    if (/deliv|ship|when|time|day|kab|arriva|track|parcel|rider|dispatch/.test(text)) {
        return `Hello ${customerName}! 🚚 Order #${orderNum} status is currently *${status}*. Delivery across ${city} takes 2-4 business days via Cash on Delivery. Our rider will contact you prior to delivery!`;
    }

    // Intent 3: Price, Discount & COD Amount
    if (/price|amount|cost|cod|discount|pay|rupee|dirham|aed|kam|rate/.test(text)) {
        return `Hello ${customerName}! 💰 The total Cash on Delivery (COD) amount for order #${orderNum} is *${amount} AED*. Our delivery rider will collect this exact amount upon delivery.`;
    }

    // Intent 4: Address or Location
    if (/address|location|city|place|pata|change/.test(text)) {
        return `Hello ${customerName}! 📍 Your delivery location is registered as *${city}*. If you wish to update your full delivery address, please reply with your new complete address here.`;
    }

    // Intent 5: Human Agent / Help
    if (/agent|human|admin|call|phone|talk|help|support/.test(text)) {
        return `Hello ${customerName}! 👤 Our support team has been notified of your message. An agent will review your chat and assist you shortly.`;
    }

    // Default Smart AI Response
    return `Hello ${customerName}! 👋 We received your message regarding order #${orderNum} (${productName}). We have noted your request and our support team will assist you shortly!`;
}

// Lock Set to prevent concurrent duplicate message sending for the same order
const processingOrders = new Set();

// Helper to check if WhatsApp service is enabled for user via RLS-bypassing RPC
async function isUserWhatsAppEnabled(userId) {
    if (!userId) return false;
    try {
        const { data, error } = await supabase.rpc('check_whatsapp_confirmation_enabled', { target_user_id: userId });
        if (!error && typeof data === 'boolean') {
            return data;
        }
    } catch (e) {
        console.warn('RPC check warning:', e.message);
    }
    const { data: userProfile } = await supabase
        .from('profiles')
        .select('whatsapp_confirmation_enabled')
        .eq('id', userId)
        .maybeSingle();
    return Boolean(userProfile?.whatsapp_confirmation_enabled);
}

// Function to Send Automated Order Confirmation
async function sendOrderConfirmationWhatsApp(orderId, isManualTrigger = false) {
    if (!waSock || !isConnected) {
        console.warn('⚠️ Cannot send WhatsApp message: Bot is not connected yet.');
        return { success: false, error: 'WhatsApp Bot not connected' };
    }

    if (!orderId) return { success: false, error: 'orderId is required' };

    // Prevent concurrent duplicate executions for the same orderId
    if (processingOrders.has(orderId)) {
        console.log(`⏳ Order #${orderId} is currently being processed by another trigger. Skipping duplicate.`);
        return { success: true, message: 'Already processing' };
    }

    processingOrders.add(orderId);

    try {
        const isUuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(orderId);
        let order = null;

        for (let attempt = 0; attempt < 3; attempt++) {
            if (isUuid) {
                const { data: o } = await supabase.from('orders').select('*').eq('id', orderId).maybeSingle();
                if (o) { order = o; break; }
            }
            // Also try matching by order_number
            const { data: oByNum } = await supabase.from('orders').select('*').eq('order_number', orderId).maybeSingle();
            if (oByNum) { order = oByNum; break; }

            // Wait 1.5s for database indexing if order was just created
            await new Promise((resolve) => setTimeout(resolve, 1500));
        }

        if (!order) {
            console.error(`Order not found for ID or Order Number after retries: ${orderId}`);
            return { success: false, error: 'Order not found in database' };
        }

        // Check if WhatsApp confirmation service is enabled for this seller/user (only for automatic triggers)
        if (!isManualTrigger && order.user_id) {
            const isEnabled = await isUserWhatsAppEnabled(order.user_id);
            if (!isEnabled) {
                console.log(`⚠️ WhatsApp confirmation is DISABLED for user ${order.user_id}. Skipping automatic message.`);
                return { success: false, reason: 'Disabled for user' };
            }
        }

        // Deduplication Check: Skip if initial message was already sent for this order
        const { data: existingMsg } = await supabase
            .from('whatsapp_messages')
            .select('id')
            .eq('order_id', order.id)
            .limit(1)
            .maybeSingle();

        if (existingMsg) {
            console.log(`⚠️ Initial WhatsApp confirmation already sent for order #${order.order_number || order.id}. Skipping duplicate.`);
            return { success: true, message: 'Already sent' };
        }

        // Fetch Product Info & Product Image
        let productName = 'Item';
        let imageUrl = null;

        if (order.product_id) {
            const { data: prod } = await supabase
                .from('products')
                .select('name, image_url, images')
                .eq('id', order.product_id)
                .maybeSingle();

            if (prod) {
                if (prod.name) productName = prod.name;
                imageUrl = prod.image_url || (Array.isArray(prod.images) ? prod.images[0] : null);
            }
        }

        const jid = await resolveJid(order.customer_phone);
        if (!jid) {
            return { success: false, error: 'Invalid customer phone number' };
        }

        // Clean & simple template (NO SKU, NO Product Description)
        const amount = order.cod_amount || order.payable_amount || 0;
        const customerName = order.customer_name || 'Customer';
        const storeName = order.store_name || 'Deserts Store';
        const orderNum = order.order_number || order.id.slice(0, 6);
        const city = order.city || order.emirate || 'UAE';

        const messageBody =
            `Hello ${customerName}, thanks for your order with ${storeName}!\n\n` +
            `📦 *Order Number:* #${orderNum}\n` +
            `🛍️ *Product:* ${productName}\n` +
            `💰 *Payable COD Amount:* ${amount} AED\n` +
            `📍 *Delivery City:* ${city}\n\n` +
            `We will deliver with Cash on Delivery.\n\n` +
            `Please reply with *"Confirm"* to confirm or *"Cancel"* to cancel your order.`;

        // Send WhatsApp Message with Product Image if available
        console.log(`📤 Sending WhatsApp Confirmation for Order #${orderNum} to ${jid}...`);
        if (imageUrl) {
            try {
                await waSock.sendMessage(jid, {
                    image: { url: imageUrl },
                    caption: messageBody
                });
                console.log(`✅ SENT WhatsApp Confirmation WITH PRODUCT IMAGE to ${jid}`);
            } catch (imgErr) {
                console.warn('Could not send image media, fallback to text message:', imgErr.message);
                await waSock.sendMessage(jid, { text: messageBody });
            }
        } else {
            await waSock.sendMessage(jid, { text: messageBody });
            console.log(`✅ SENT WhatsApp Confirmation Text to ${jid}`);
        }

        // Create or get WhatsApp Chat in Supabase
        const cleanPhone = jid.split('@')[0].split(':')[0].replace(/\D/g, '');
        let { data: chat } = await supabase
            .from('whatsapp_chats')
            .select('id')
            .eq('order_id', order.id)
            .maybeSingle();

        if (!chat) {
            const { data: newChat } = await supabase
                .from('whatsapp_chats')
                .insert({
                    order_id: order.id,
                    phone_number: cleanPhone,
                    customer_name: customerName,
                    last_message: messageBody,
                    last_message_at: new Date().toISOString(),
                    status: 'pending'
                })
                .select()
                .single();
            chat = newChat;
        } else {
            await supabase
                .from('whatsapp_chats')
                .update({
                    last_message: messageBody,
                    last_message_at: new Date().toISOString()
                })
                .eq('id', chat.id);
        }

        // Insert initial sent message
        if (chat) {
            await supabase.from('whatsapp_messages').insert({
                chat_id: chat.id,
                order_id: order.id,
                sender: 'bot',
                message_type: imageUrl ? 'image' : 'text',
                message_text: messageBody,
                media_url: imageUrl,
                status: 'sent'
            });
        }

        return { success: true, chat_id: chat?.id };
    } catch (err) {
        console.error('Error sending order confirmation WhatsApp:', err);
        return { success: false, error: err.message };
    } finally {
        setTimeout(() => {
            processingOrders.delete(orderId);
        }, 15000);
    }
}

// Subscribe to Supabase Realtime for New Orders
function listenToNewOrders() {
    console.log('📡 Subscribing to Supabase Realtime for new Order triggers...');

    supabase
        .channel('new_orders_channel')
        .on(
            'postgres_changes',
            { event: 'INSERT', schema: 'public', table: 'orders' },
            async (payload) => {
                const newOrder = payload.new;
                console.log(`🆕 NEW ORDER RECEIVED VIA REALTIME: #${newOrder.order_number || newOrder.id} (${newOrder.customer_name})`);

                setTimeout(() => {
                    sendOrderConfirmationWhatsApp(newOrder.id, false);
                }, 1500);
            }
        )
        .subscribe((status) => {
            console.log(`📡 Realtime new_orders_channel status: ${status}`);
        });
}

// Failsafe Automatic Poller: Checks every 10s for new orders from enabled users that need confirmation
async function autoCheckUnsentOrders() {
    if (!isConnected || !waSock) return;

    try {
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
        const { data: recentOrders, error } = await supabase
            .from('orders')
            .select('id, user_id, order_number, customer_name, profiles(whatsapp_confirmation_enabled)')
            .gte('created_at', twoHoursAgo)
            .order('created_at', { ascending: false });

        if (error || !recentOrders || recentOrders.length === 0) return;

        for (const order of recentOrders) {
            if (!order.user_id) continue;

            const isEnabled = await isUserWhatsAppEnabled(order.user_id);
            if (!isEnabled) continue;

            const { data: existingMsg } = await supabase
                .from('whatsapp_messages')
                .select('id')
                .eq('order_id', order.id)
                .limit(1)
                .maybeSingle();

            if (!existingMsg) {
                console.log(`🤖 Auto-Poller: Found unsent order #${order.order_number || order.id} for enabled user. Sending automatic WhatsApp message...`);
                await sendOrderConfirmationWhatsApp(order.id, false);
            }
        }
    } catch (err) {
        console.error('Error in autoCheckUnsentOrders poller:', err.message);
    }
}

// Express API Routes for Admin UI & Control
app.get('/', (req, res) => {
    res.redirect('/qr');
});

app.get('/status', (req, res) => {
    res.json({
        connected: isConnected,
        botJid: botUserJid,
        hasQr: !!qrCodeData
    });
});

app.get('/reset-session', async (req, res) => {
    try {
        isConnected = false;
        qrCodeData = null;
        if (waSock) {
            try { waSock.end(); } catch (e) {}
        }
        const fs = await import('fs');
        if (fs.existsSync('./auth_info_baileys')) {
            fs.rmSync('./auth_info_baileys', { recursive: true, force: true });
        }
        console.log('🔄 Session reset manually by admin via /reset-session');
        setTimeout(startWhatsAppBot, 1500);
        res.send(`
            <html>
                <head>
                    <meta http-equiv="refresh" content="3;url=/qr" />
                    <style>body { font-family: system-ui, sans-serif; text-align: center; padding: 50px; background: #f8fafc; }</style>
                </head>
                <body>
                    <h2 style="color:#0284c7;">🔄 Resetting WhatsApp session...</h2>
                    <p>Generating a fresh QR code. Redirecting in 3 seconds...</p>
                    <p><a href="/qr" style="color:#0284c7; font-weight:bold;">Click here if not redirected automatically</a></p>
                </body>
            </html>
        `);
    } catch (err) {
        console.error('Reset session error:', err);
        res.status(500).send('Reset error: ' + err.message);
    }
});

app.get('/qr', (req, res) => {
    if (isConnected) {
        return res.send(`
            <html>
                <head>
                    <title>Deserts WhatsApp Bot - Connected</title>
                    <style>body { font-family: system-ui, sans-serif; text-align: center; padding: 50px; background: #f8fafc; }</style>
                </head>
                <body>
                    <div style="background: white; padding: 40px; border-radius: 20px; display: inline-block; box-shadow: 0 10px 30px rgba(0,0,0,0.08);">
                        <h2 style="color:#16a34a; margin-bottom:10px;">✅ WhatsApp Bot is Connected!</h2>
                        <p style="color:#64748b;">Bot is active and ready to deliver messages and auto-replies.</p>
                        <br/>
                        <a href="/reset-session" style="padding:10px 20px; background:#ef4444; color:white; border-radius:10px; text-decoration:none; font-weight:bold; font-size:13px;">🔄 Disconnect & Re-scan New QR Code</a>
                    </div>
                </body>
            </html>
        `);
    }

    if (!qrCodeData) {
        return res.send(`
            <html>
                <head>
                    <meta http-equiv="refresh" content="3" />
                    <title>Initializing QR Code</title>
                    <style>body { font-family: system-ui, sans-serif; text-align: center; padding: 50px; background: #f8fafc; }</style>
                </head>
                <body>
                    <div style="background: white; padding: 40px; border-radius: 20px; display: inline-block; box-shadow: 0 10px 30px rgba(0,0,0,0.08);">
                        <h2 style="color:#ea580c; margin-bottom:10px;">⌛ Initializing QR Code...</h2>
                        <p style="color:#64748b;">Starting WhatsApp engine. Page reloads automatically in 3 seconds...</p>
                        <br/>
                        <a href="/reset-session" style="padding:10px 20px; background:#ef4444; color:white; border-radius:10px; text-decoration:none; font-weight:bold; font-size:13px;">🔄 Force Reset Session & Generate New QR</a>
                    </div>
                </body>
            </html>
        `);
    }

    res.send(`
        <html>
            <head>
                <title>Deserts WhatsApp QR Code</title>
                <script src="https://cdn.jsdelivr.net/npm/qrcode@1.5.1/build/qrcode.min.js"></script>
                <style>
                    body { font-family: system-ui, sans-serif; text-align: center; padding: 40px; background: #f8fafc; }
                    .card { background: white; padding: 30px; border-radius: 20px; display: inline-block; box-shadow: 0 10px 25px rgba(0,0,0,0.08); }
                    canvas { margin: 20px 0; }
                </style>
            </head>
            <body>
                <div class="card">
                    <h2 style="color:#0f766e; margin-bottom: 5px;">📱 Connect Deserts WhatsApp Bot</h2>
                    <p style="color:#64748b;">Scan this QR code using WhatsApp on your phone (Linked Devices):</p>
                    <canvas id="canvas"></canvas>
                    <p style="font-size:12px;color:#94a3b8;">Page auto-refreshes every 10 seconds</p>
                    <div style="margin-top:15px;">
                        <a href="/reset-session" style="padding:8px 16px; background:#ef4444; color:white; border-radius:8px; text-decoration:none; font-weight:bold; font-size:12px;">🔄 Generate New QR Code</a>
                    </div>
                </div>
                <script>
                    QRCode.toCanvas(document.getElementById('canvas'), "${qrCodeData}", { width: 260 }, function (error) {
                        if (error) console.error(error)
                    });
                    setTimeout(() => window.location.reload(), 10000);
                </script>
            </body>
        </html>
    `);
});

// Trigger sending message manually for any order from Portal
app.post('/send-order-message', async (req, res) => {
    const { orderId, isManual } = req.body;
    if (!orderId) return res.status(400).json({ error: 'orderId is required' });

    const isManualTrigger = isManual !== undefined ? Boolean(isManual) : true;
    const result = await sendOrderConfirmationWhatsApp(orderId, isManualTrigger);
    res.json(result);
});

// Send Automated Onboarding Welcome WhatsApp Message to Newly Registered Seller
app.post('/send-onboarding-message', async (req, res) => {
    const { phone, fullName, email } = req.body;
    if (!phone || !fullName) {
        return res.status(400).json({ error: 'phone and fullName are required' });
    }

    if (!waSock || !isConnected) {
        return res.status(503).json({ error: 'WhatsApp Bot not connected' });
    }

    try {
        const jid = await resolveJid(phone);
        if (!jid) return res.status(400).json({ error: 'Invalid phone number format' });

        const welcomeText =
            `🎉 *Welcome to Deserts Dropshipping, ${fullName}!* 🚀\n\n` +
            `Thank you for registering your seller account (${email || 'registered email'}).\n\n` +
            `📋 Your application has been received and is currently under review by our team.\n` +
            `We will notify you once your account is approved and ready to process orders.\n\n` +
            `Happy Selling! 💼✨`;

        console.log(`📤 Sending WhatsApp Onboarding Welcome Message to ${jid}...`);
        await waSock.sendMessage(jid, { text: welcomeText });

        res.json({ success: true });
    } catch (err) {
        console.error('Error sending onboarding WhatsApp message:', err);
        res.status(500).json({ error: err.message });
    }
});

// Send Automated Account Approval / Disapproval Status WhatsApp Message to Seller
app.post('/send-account-status-message', async (req, res) => {
    const { phone, fullName, email, storeName, status } = req.body;
    if (!phone || !fullName || !status) {
        return res.status(400).json({ error: 'phone, fullName, and status are required' });
    }

    if (!waSock || !isConnected) {
        return res.status(503).json({ error: 'WhatsApp Bot not connected' });
    }

    try {
        const jid = await resolveJid(phone);
        if (!jid) return res.status(400).json({ error: 'Invalid phone number format' });

        let messageText = '';
        const isApproved = status.toLowerCase() === 'approved';

        if (isApproved) {
            messageText =
                `🎉 *Congratulations, ${fullName}!* 🚀\n\n` +
                `Your seller account for *${storeName || 'Deserts Dropshipping'}* has been *APPROVED*! ✅\n\n` +
                `You can now log in to the portal and start listing products and placing orders.\n\n` +
                `Portal URL: https://system.desertsdropshipper.com/\n\n` +
                `Happy Selling! 💼✨`;
        } else {
            messageText =
                `⚠️ *Account Status Notice*\n\n` +
                `Hello ${fullName}, your seller account for *${storeName || 'Deserts Dropshipping'}* status has been updated to *${status.toUpperCase()}*.\n\n` +
                `If you have any questions or need assistance, please contact portal admin.\n\n` +
                `Thank you!`;
        }

        console.log(`📤 Sending Account Status WhatsApp Message (${status}) to ${jid}...`);
        await waSock.sendMessage(jid, { text: messageText });

        res.json({ success: true });
    } catch (err) {
        console.error('Error sending account status WhatsApp message:', err);
        res.status(500).json({ error: err.message });
    }
});

// Admin Manual Reply via WhatsApp Modal
app.post('/send-manual-message', async (req, res) => {
    const { orderId, phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ error: 'phone and message are required' });

    if (!waSock || !isConnected) {
        return res.status(503).json({ error: 'WhatsApp bot is not connected' });
    }

    try {
        const jid = await resolveJid(phone);
        console.log(`📤 Sending manual WhatsApp message to ${jid}: "${message}"`);
        await waSock.sendMessage(jid, { text: message });

        const cleanPhone = jid.split('@')[0].split(':')[0].replace(/\D/g, '');

        // 1. Get or Create Chat row
        let { data: chat } = await supabase
            .from('whatsapp_chats')
            .select('id')
            .eq('order_id', orderId)
            .maybeSingle();

        if (!chat && cleanPhone) {
            const { data: chatByPhone } = await supabase
                .from('whatsapp_chats')
                .select('id')
                .eq('phone_number', cleanPhone)
                .order('last_message_at', { ascending: false })
                .limit(1)
                .maybeSingle();
            chat = chatByPhone;
        }

        if (!chat) {
            const { data: newChat } = await supabase
                .from('whatsapp_chats')
                .insert({
                    order_id: orderId,
                    phone_number: cleanPhone,
                    customer_name: 'Customer',
                    last_message: message,
                    last_message_at: new Date().toISOString()
                })
                .select()
                .single();
            chat = newChat;
        }

        // 2. Insert message row into DB
        if (chat) {
            await supabase.from('whatsapp_messages').insert({
                chat_id: chat.id,
                order_id: orderId,
                sender: 'agent',
                message_type: 'text',
                message_text: message,
                status: 'sent'
            });

            await supabase.from('whatsapp_chats').update({
                last_message: message,
                last_message_at: new Date().toISOString()
            }).eq('id', chat.id);

            console.log(`✅ Saved manual message to chat ${chat.id}`);
        }

        res.json({ success: true });
    } catch (err) {
        console.error('Error in send-manual-message:', err);
        res.status(500).json({ error: err.message });
    }
});

// Start Express Server & WhatsApp Client
app.listen(PORT, () => {
    console.log(`🚀 Deserts WhatsApp Bot Server running on http://localhost:${PORT}`);
    startWhatsAppBot();
    listenToNewOrders();

    // Start 10-second automatic poller for 100% guaranteed automatic messaging
    setInterval(() => {
        autoCheckUnsentOrders();
    }, 10000);
});
