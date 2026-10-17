const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { io } = require("socket.io-client");
const net = require("node:net");
const crypto = require("node:crypto");

const accessToken = crypto.randomBytes(32).toString("hex");
let serverProcess;
let serverAddress;
let serverPort;

async function findAvailablePort() {
    const temporaryServer = net.createServer();
    temporaryServer.listen(0, "127.0.0.1");
    await once(temporaryServer, "listening");
    const availablePort = temporaryServer.address().port;

    await new Promise((resolve, reject) => {
        temporaryServer.close((error) => error ? reject(error) : resolve());
    });

    return availablePort;
}

async function waitForServer(url) {
    for (let attempt = 0; attempt < 60; attempt++) {
        try {
            const response = await fetch(url);
            if (response.ok) return;
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    }
    throw new Error("Test server did not start in time.");
}

test("HTTP health, readiness, ping, and request identifiers work", async () => {
    serverPort = await findAvailablePort();
    serverAddress = `http://127.0.0.1:${serverPort}`;

    serverProcess = spawn(process.execPath, ["server.js"], {
        env: {
            ...process.env,
            PORT: String(serverPort),
            DEVICE_TEST_TOKEN: accessToken,
            ALLOWED_ORIGINS: "http://localhost:3000"
        },
        stdio: "ignore"
    });

    await waitForServer(`${serverAddress}/health`);

    const rootResponse = await fetch(`${serverAddress}/`);
    assert.equal(rootResponse.status, 200);
    assert.equal((await rootResponse.json()).version, "2.0.0");
    assert.ok(rootResponse.headers.get("x-request-id"));

    const pingResponse = await fetch(`${serverAddress}/ping`);
    assert.equal(pingResponse.status, 200);
    assert.equal((await pingResponse.json()).status, "pong");

    const healthResponse = await fetch(`${serverAddress}/health`);
    const health = await healthResponse.json();
    assert.equal(health.status, "ok");
    assert.equal(health.connectedClients, 0);

    const readinessResponse = await fetch(`${serverAddress}/ready`);
    assert.equal(readinessResponse.status, 200);
    assert.equal((await readinessResponse.json()).ready, true);
});

test("protected endpoints reject missing credentials", async () => {
    const devicesResponse = await fetch(`${serverAddress}/devices`);
    assert.equal(devicesResponse.status, 401);

    const metricsResponse = await fetch(`${serverAddress}/metrics`);
    assert.equal(metricsResponse.status, 401);
});

test("authorized metrics endpoint returns service information", async () => {
    const response = await fetch(`${serverAddress}/metrics`, {
        headers: { "x-access-token": accessToken }
    });

    assert.equal(response.status, 200);
    const metrics = await response.json();
    assert.equal(metrics.service, "secure-device-test-server");
    assert.equal(typeof metrics.memoryBytes.rss, "number");
});

test("unauthorized Socket.IO clients are rejected", async () => {
    const client = io(serverAddress, {
        auth: { token: "invalid-token" },
        reconnection: false,
        timeout: 3000
    });

    try {
        const [error] = await once(client, "connect_error");
        assert.match(error.message, /Unauthorized/);
    } finally {
        client.disconnect();
    }
});

test("authorized Socket.IO clients can connect and send test pings", async () => {
    const client = io(serverAddress, {
        auth: {
            token: accessToken,
            deviceName: "Authorized test client"
        },
        reconnection: false,
        timeout: 3000
    });

    try {
        await once(client, "connect");
        const [status] = await once(client, "server_status");
        assert.equal(status.status, "connected");

        const result = await new Promise((resolve, reject) => {
            client.timeout(3000).emit(
                "test_ping",
                { testId: "test-001" },
                (error, response) => error ? reject(error) : resolve(response)
            );
        });

        assert.equal(result.success, true);
        assert.equal(result.testId, "test-001");
        assert.equal(typeof result.remainingEvents, "number");

        const devicesResponse = await fetch(`${serverAddress}/devices`, {
            headers: { "x-access-token": accessToken }
        });
        assert.equal(devicesResponse.status, 200);

        const deviceList = await devicesResponse.json();
        assert.equal(deviceList.devices.length, 1);
        assert.equal(deviceList.devices[0].name, "Authorized test client");
    } finally {
        client.disconnect();
    }
});

test("unknown routes return a JSON 404 response", async () => {
    const response = await fetch(`${serverAddress}/missing-route`);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, "Not found");
});

after(async () => {
    if (serverProcess && serverProcess.exitCode === null) {
        serverProcess.kill("SIGTERM");
        await Promise.race([
            once(serverProcess, "exit"),
            new Promise((resolve) => setTimeout(resolve, 4000))
        ]);
    }
});
