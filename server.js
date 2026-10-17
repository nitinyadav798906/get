const express = require("express");
const http = require("node:http");
const crypto = require("node:crypto");
const helmet = require("helmet");
const { Server } = require("socket.io");
const { Telegraf } = require("telegraf");

const application = express();
const httpServer = http.createServer(application);

const port = Number(process.env.PORT || 8080);
const accessToken = process.env.DEVICE_TEST_TOKEN;
const serviceName = process.env.SERVICE_NAME || "secure-device-test-server";
const publicUrl = (process.env.RENDER_EXTERNAL_URL || "").replace(/\/+$/, "");
const botToken = process.env.BOT_TOKEN;
const adminChatIds = (process.env.ADMIN_CHAT_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

// Render ka apna public URL automatically allowed origins mein add ho jata hai.
const allowedOrigins = [
    ...(process.env.ALLOWED_ORIGINS || "http://localhost:3000,http://127.0.0.1:3000").split(","),
    publicUrl
]
    .map((origin) => origin.trim())
    .filter(Boolean);

const maximumEventsPerMinute = Number(process.env.MAX_EVENTS_PER_MINUTE || 60);
const maximumConnectionsPerIp = Number(process.env.MAX_CONNECTIONS_PER_IP || 10);
const keepAliveEnabled = (process.env.KEEP_ALIVE || "true") === "true";
const startedAt = Date.now();

if (!accessToken || accessToken.length < 32) {
    console.error("Configuration error: DEVICE_TEST_TOKEN must contain at least 32 characters.");
    process.exit(1);
}

if (!Number.isInteger(maximumEventsPerMinute) || maximumEventsPerMinute < 1) {
    console.error("Configuration error: MAX_EVENTS_PER_MINUTE must be a positive integer.");
    process.exit(1);
}

application.disable("x-powered-by");
application.set("trust proxy", 1);
application.use(helmet());
application.use(express.json({ limit: "1mb", strict: true }));

const connectedDevices = new Map();
const connectionsByIp = new Map();
const recentRequestCounts = new Map();
let isShuttingDown = false;
let botMode = "disabled";

/* ------------------------------------------------------------------ */
/* Telegram bot                                                        */
/* ------------------------------------------------------------------ */

let bot = null;
let webhookPath = null;
let webhookSecret = null;

function isAdmin(ctx) {
    return adminChatIds.includes(String(ctx.from?.id));
}

if (botToken) {
    bot = new Telegraf(botToken);

    const botHash = crypto.createHash("sha256").update(botToken).digest("hex");
    webhookPath = `/telegram/${botHash.slice(0, 32)}`;
    webhookSecret = botHash.slice(32, 64);

    bot.start((ctx) =>
        ctx.reply(
            "Namaste! Bot chal raha hai ✅\n\n" +
            "Commands:\n" +
            "/ping - bot check\n" +
            "/status - server status\n" +
            "/devices - connected clients (admin)\n" +
            "/id - aapki chat ID\n" +
            "/help - help"
        )
    );

    bot.help((ctx) =>
        ctx.reply(
            "Available commands:\n" +
            "/start\n/ping\n/status\n/devices\n/id\n/help"
        )
    );

    bot.command("ping", (ctx) => ctx.reply("pong 🏓"));

    bot.command("id", (ctx) =>
        ctx.reply(`Aapki user ID: ${ctx.from.id}\nChat ID: ${ctx.chat.id}`)
    );

    bot.command("status", (ctx) =>
        ctx.reply(
            "Server OK ✅\n" +
            `Service: ${serviceName}\n` +
            `Uptime: ${Math.floor(process.uptime())}s\n` +
            `Connected clients: ${connectedDevices.size}`
        )
    );

    bot.command("devices", (ctx) => {
        if (adminChatIds.length === 0) {
            return ctx.reply("ADMIN_CHAT_IDS set nahi hai. /id se apni ID lo aur Render Environment mein add karo.");
        }
        if (!isAdmin(ctx)) {
            return ctx.reply("Ye command sirf admin ke liye hai.");
        }
        if (connectedDevices.size === 0) {
            return ctx.reply("Abhi koi client connected nahi hai.");
        }
        const lines = Array.from(connectedDevices.values()).map(
            (device, index) => `${index + 1}. ${device.name} (since ${device.connectedAt})`
        );
        return ctx.reply(`Connected clients (${lines.length}):\n${lines.join("\n")}`);
    });

    // Unknown commands
    bot.on("text", (ctx) => {
        if (ctx.message.text.startsWith("/")) {
            return ctx.reply("Ye command samajh nahi aaya. /help dekho.");
        }
    });

    bot.catch((error, ctx) => {
        console.error(JSON.stringify({
            event: "bot_error",
            updateType: ctx?.updateType,
            message: error?.message
        }));
    });

    // Webhook route: rate limiter se pehle mount hona zaroori hai.
    application.use(bot.webhookCallback(webhookPath, { secretToken: webhookSecret }));
} else {
    console.warn("BOT_TOKEN set nahi hai. Telegram bot disabled.");
}

/* ------------------------------------------------------------------ */
/* Socket.IO                                                           */
/* ------------------------------------------------------------------ */

const socketServer = new Server(httpServer, {
    cors: {
        origin(origin, callback) {
            if (!origin || allowedOrigins.includes(origin)) {
                return callback(null, true);
            }
            return callback(new Error("Origin is not allowed."));
        },
        methods: ["GET", "POST"]
    },
    maxHttpBufferSize: 32 * 1024,
    connectTimeout: 10000,
    pingInterval: 25000,
    pingTimeout: 20000,
    transports: ["websocket", "polling"]
});

function safeEqualTokens(providedToken, expectedToken) {
    if (typeof providedToken !== "string") return false;

    const providedBuffer = Buffer.from(providedToken);
    const expectedBuffer = Buffer.from(expectedToken);

    return providedBuffer.length === expectedBuffer.length &&
        crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}

// FIX: Render proxy ke peeche handshake.address sabke liye same hota hai,
// isliye asli client IP x-forwarded-for se lete hain.
function getClientIp(requestOrSocket) {
    if (requestOrSocket.handshake) {
        const forwarded = requestOrSocket.handshake.headers["x-forwarded-for"];
        if (typeof forwarded === "string" && forwarded.length > 0) {
            return forwarded.split(",")[0].trim();
        }
        return requestOrSocket.handshake.address;
    }
    return requestOrSocket.ip;
}

function createRequestIdentifier() {
    return crypto.randomUUID();
}

function authenticateHttpRequest(request, response, next) {
    const suppliedToken = request.get("x-access-token");

    if (!safeEqualTokens(suppliedToken, accessToken)) {
        return response.status(401).json({
            error: "Unauthorized",
            requestId: request.requestId
        });
    }

    next();
}

function applyRateLimit(key, maximumRequests, windowMilliseconds) {
    const currentTime = Date.now();
    const existingEntry = recentRequestCounts.get(key);

    if (!existingEntry || currentTime >= existingEntry.resetAt) {
        recentRequestCounts.set(key, {
            count: 1,
            resetAt: currentTime + windowMilliseconds
        });
        return { allowed: true, remaining: maximumRequests - 1 };
    }

    if (existingEntry.count >= maximumRequests) {
        return {
            allowed: false,
            remaining: 0,
            retryAfterSeconds: Math.max(1, Math.ceil((existingEntry.resetAt - currentTime) / 1000))
        };
    }

    existingEntry.count += 1;
    return {
        allowed: true,
        remaining: maximumRequests - existingEntry.count
    };
}

/* ------------------------------------------------------------------ */
/* HTTP routes                                                         */
/* ------------------------------------------------------------------ */

application.use((request, response, next) => {
    request.requestId = createRequestIdentifier();
    response.setHeader("X-Request-Id", request.requestId);
    response.setHeader("Cache-Control", "no-store");
    next();
});

application.use((request, response, next) => {
    const ip = request.ip || "unknown";
    const limit = applyRateLimit(`http:${ip}`, 120, 60_000);

    response.setHeader("X-RateLimit-Limit", "120");
    response.setHeader("X-RateLimit-Remaining", String(limit.remaining));

    if (!limit.allowed) {
        response.setHeader("Retry-After", String(limit.retryAfterSeconds));
        return response.status(429).json({
            error: "Too many requests",
            requestId: request.requestId
        });
    }

    next();
});

application.get("/", (request, response) => {
    response.status(200).json({
        service: serviceName,
        status: isShuttingDown ? "shutting_down" : "ok",
        version: "2.1.0",
        bot: botMode,
        requestId: request.requestId
    });
});

application.get("/ping", (request, response) => {
    response.status(200).json({
        status: "pong",
        timestamp: new Date().toISOString(),
        requestId: request.requestId
    });
});

application.get("/health", (request, response) => {
    response.status(isShuttingDown ? 503 : 200).json({
        status: isShuttingDown ? "shutting_down" : "ok",
        uptimeSeconds: Math.floor(process.uptime()),
        connectedClients: connectedDevices.size,
        bot: botMode,
        timestamp: new Date().toISOString(),
        requestId: request.requestId
    });
});

application.get("/ready", (request, response) => {
    const ready = !isShuttingDown && httpServer.listening;
    response.status(ready ? 200 : 503).json({
        ready,
        requestId: request.requestId
    });
});

application.get("/metrics", authenticateHttpRequest, (request, response) => {
    response.status(200).json({
        service: serviceName,
        uptimeSeconds: Math.floor(process.uptime()),
        processUptimeSeconds: Math.floor(process.uptime()),
        memoryBytes: process.memoryUsage(),
        connectedClients: connectedDevices.size,
        totalTrackedIpConnections: connectionsByIp.size,
        rateLimitBuckets: recentRequestCounts.size,
        bot: botMode,
        shuttingDown: isShuttingDown
    });
});

application.get("/devices", authenticateHttpRequest, (request, response) => {
    response.status(200).json({
        devices: Array.from(connectedDevices.values()).map((device) => ({
            id: device.id,
            name: device.name,
            connectedAt: device.connectedAt,
            lastSeenAt: device.lastSeenAt,
            clientIp: device.clientIp
        }))
    });
});

application.use((request, response) => {
    response.status(404).json({
        error: "Not found",
        requestId: request.requestId
    });
});

application.use((error, request, response, next) => {
    if (response.headersSent) return next(error);

    const statusCode = error.status === 413 ? 413 : 400;
    response.status(statusCode).json({
        error: statusCode === 413 ? "Request body too large" : "Invalid request",
        requestId: request.requestId
    });
});

/* ------------------------------------------------------------------ */
/* Socket auth + events                                                */
/* ------------------------------------------------------------------ */

socketServer.use((socket, next) => {
    if (isShuttingDown) return next(new Error("Server is shutting down."));

    const suppliedToken = socket.handshake.auth?.token;
    if (!safeEqualTokens(suppliedToken, accessToken)) {
        return next(new Error("Unauthorized connection"));
    }

    const origin = socket.handshake.headers.origin;
    if (origin && !allowedOrigins.includes(origin)) {
        return next(new Error("Origin is not allowed."));
    }

    const clientIp = getClientIp(socket);
    const currentConnections = connectionsByIp.get(clientIp) || 0;

    if (currentConnections >= maximumConnectionsPerIp) {
        return next(new Error("Connection limit reached."));
    }

    next();
});

socketServer.on("connection", (socket) => {
    const clientIp = getClientIp(socket);
    connectionsByIp.set(clientIp, (connectionsByIp.get(clientIp) || 0) + 1);

    const device = {
        id: socket.id,
        name: String(socket.handshake.auth?.deviceName || "Test client").slice(0, 80),
        connectedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        clientIp
    };

    connectedDevices.set(socket.id, device);

    console.log(JSON.stringify({
        event: "client_connected",
        clientId: socket.id,
        timestamp: device.connectedAt
    }));

    socket.emit("server_status", {
        status: "connected",
        clientId: socket.id,
        serverTime: new Date().toISOString()
    });

    socket.on("test_ping", (payload, acknowledge) => {
        const rateLimit = applyRateLimit(
            `socket:${socket.id}`,
            maximumEventsPerMinute,
            60_000
        );

        if (!rateLimit.allowed) {
            if (typeof acknowledge === "function") {
                acknowledge({ success: false, error: "Rate limit exceeded" });
            }
            return;
        }

        device.lastSeenAt = new Date().toISOString();

        if (typeof acknowledge === "function") {
            acknowledge({
                success: true,
                receivedAt: device.lastSeenAt,
                testId: typeof payload?.testId === "string"
                    ? payload.testId.slice(0, 80)
                    : null,
                remainingEvents: rateLimit.remaining
            });
        }
    });

    socket.on("disconnect", (reason) => {
        connectedDevices.delete(socket.id);

        const remainingConnections = Math.max(
            0,
            (connectionsByIp.get(clientIp) || 1) - 1
        );

        if (remainingConnections === 0) {
            connectionsByIp.delete(clientIp);
        } else {
            connectionsByIp.set(clientIp, remainingConnections);
        }

        console.log(JSON.stringify({
            event: "client_disconnected",
            clientId: socket.id,
            reason,
            timestamp: new Date().toISOString()
        }));
    });
});

/* ------------------------------------------------------------------ */
/* Housekeeping                                                        */
/* ------------------------------------------------------------------ */

const cleanupInterval = setInterval(() => {
    const currentTime = Date.now();

    for (const [key, value] of recentRequestCounts.entries()) {
        if (currentTime >= value.resetAt) recentRequestCounts.delete(key);
    }
}, 60_000);

cleanupInterval.unref();

// Render free plan 15 min idle ke baad sula deta hai. Ye apne hi public
// URL ko ping karta hai taaki bot jaldi reply kare.
let keepAliveInterval = null;

function startKeepAlive() {
    if (!keepAliveEnabled || !publicUrl) return;

    keepAliveInterval = setInterval(() => {
        fetch(`${publicUrl}/health`).catch((error) => {
            console.warn(JSON.stringify({ event: "keepalive_failed", message: error.message }));
        });
    }, 10 * 60_000);

    keepAliveInterval.unref();
}

async function startBot() {
    if (!bot) return;

    try {
        await bot.telegram.setMyCommands([
            { command: "start", description: "Bot shuru karo" },
            { command: "help", description: "Help" },
            { command: "ping", description: "Bot check" },
            { command: "status", description: "Server status" },
            { command: "devices", description: "Connected clients (admin)" },
            { command: "id", description: "Aapki chat ID" }
        ]);

        if (publicUrl) {
            // Production (Render): webhook mode
            await bot.telegram.setWebhook(`${publicUrl}${webhookPath}`, {
                secret_token: webhookSecret
            });
            botMode = "webhook";
            console.log(JSON.stringify({ event: "telegram_webhook_set" }));
        } else {
            // Local development: polling mode
            await bot.telegram.deleteWebhook();
            bot.launch().catch((error) => {
                console.error(JSON.stringify({ event: "bot_launch_failed", message: error.message }));
            });
            botMode = "polling";
            console.log(JSON.stringify({ event: "telegram_polling_started" }));
        }
    } catch (error) {
        botMode = "error";
        console.error(JSON.stringify({ event: "bot_start_failed", message: error.message }));
    }
}

httpServer.listen(port, "0.0.0.0", () => {
    console.log(JSON.stringify({
        event: "server_started",
        service: serviceName,
        port,
        timestamp: new Date(startedAt).toISOString()
    }));

    startBot();
    startKeepAlive();
});

function shutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(JSON.stringify({
        event: "server_shutdown",
        signal,
        timestamp: new Date().toISOString()
    }));

    clearInterval(cleanupInterval);
    if (keepAliveInterval) clearInterval(keepAliveInterval);

    if (bot && botMode === "polling") {
        try { bot.stop(signal); } catch { /* ignore */ }
    }

    for (const socket of socketServer.sockets.sockets.values()) {
        socket.disconnect(true);
    }

    socketServer.close(() => {
        if (httpServer.listening) {
            httpServer.close(() => process.exit(0));
        } else {
            process.exit(0);
        }
    });

    setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
