/**
 * R17.9T.6-B — Focused SocketGateway Telegram authentication middleware tests.
 *
 * Scope: connection-level authentication ONLY.
 * - No CREATE_ROOM authorization tests.
 * - No room quota tests.
 * - No RoomLobbyBridge / gameplay / payment involvement.
 *
 * Deterministic: fixed test bot token, fixed timestamps.
 * No real Telegram credentials are used.
 */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";

import { io } from "socket.io-client";

import { LoggerService } from "../services/LoggerService.js";
import { SocketGateway } from "../socket/SocketGateway.js";

// ---- Deterministic fixtures -------------------------------------------------

const TEST_BOT_TOKEN = "1234567890:TEST_FIXED_BOT_TOKEN_NOT_REAL";
const WRONG_BOT_TOKEN = "9999999999:WRONG_TEST_TOKEN_NOT_REAL";

// The middleware uses the real clock (no nowSeconds override), so fixtures are
// built relative to the current time at module load.
const TEST_NOW = Math.floor(Date.now() / 1000);
const TEST_AUTH_DATE = TEST_NOW - 60; // fresh (well within any maxAge)
const EXPIRED_AUTH_DATE = TEST_NOW - 3600; // older than maxAgeSeconds=60

const TELEGRAM_USER_ID = 424242;
const TEST_USER = JSON.stringify({
    id: TELEGRAM_USER_ID,
    first_name: "Test",
    username: "test_user"
});

function buildDataCheckStringFor(fields) {
    return Object.keys(fields)
        .filter((k) => k !== "hash")
        .sort()
        .map((k) => `${k}=${fields[k]}`)
        .join(String.fromCharCode(10));
}

function computeHash(fields, botToken) {
    const secretKey = crypto
        .createHmac("sha256", "WebAppData")
        .update(botToken)
        .digest();
    return crypto
        .createHmac("sha256", secretKey)
        .update(buildDataCheckStringFor(fields))
        .digest("hex");
}

/**
 * Build a signed initData string deterministically.
 * hash === undefined → valid hash computed with TEST_BOT_TOKEN.
 * hash === null → no hash field at all.
 */
function buildSignedInitData(fields) {
    const withHash = { ...fields };
    if (withHash.hash === null) {
        delete withHash.hash;
    } else if (withHash.hash === undefined) {
        withHash.hash = computeHash(withHash, TEST_BOT_TOKEN);
    }
    return Object.entries(withHash)
        .map(([k, v]) => `${k}=${v}`)
        .join("&");
}

function buildValidInitData() {
    return buildSignedInitData({
        user: TEST_USER,
        auth_date: String(TEST_AUTH_DATE),
        query_id: "AAF9E7C6TEST"
    });
}

// ---- Harness ----------------------------------------------------------------

async function createAuthHarness({ telegramAuth }) {
    const logger = new LoggerService({ logLevel: "error" });
    logger.initialize();

    const httpServer = http.createServer();

    const socketGateway = new SocketGateway({
        logger,
        socketConfig: {
            cors: { origin: "*" }
        },
        telegramAuth,
        devMode: false
    });

    socketGateway.initialize(httpServer);

    await new Promise((resolve) => {
        httpServer.listen(0, "127.0.0.1", resolve);
    });

    const { port } = httpServer.address();

    return {
        port,
        socketGateway,
        async shutdown() {
            await socketGateway.shutdown();
            await new Promise((resolve, reject) => {
                if (!httpServer.listening) {
                    resolve();
                    return;
                }
                httpServer.close((error) => (error ? reject(error) : resolve()));
            });
            logger.shutdown();
        }
    };
}

function connectClient(port, auth = {}) {
    const socket = io(`http://127.0.0.1:${port}`, {
        transports: ["websocket"],
        forceNew: true,
        auth
    });
    return new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error("connection timed out")),
            5000
        );
        socket.on("connect", () => {
            clearTimeout(timer);
            resolve(socket);
        });
        socket.on("connect_error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}

async function assertRejected(port, auth) {
    await assert.rejects(
        () => connectClient(port, auth),
        (error) => error?.message === "TELEGRAM_AUTH_FAILED",
        `expected rejection with TELEGRAM_AUTH_FAILED for auth=${JSON.stringify(Object.keys(auth))}`
    );
}

// ---- Tests ------------------------------------------------------------------

test("R17.9T.6-B #1: no Telegram credentials → accepted as Web guest (telegramUserId null)", async () => {
    const harness = await createAuthHarness({
        telegramAuth: { botToken: TEST_BOT_TOKEN }
    });

    try {
        const socket = await connectClient(harness.port);

        const serverSocket = harness.socketGateway.getIO().sockets.sockets.get(
            socket.id
        );

        assert.ok(serverSocket, "server-side socket must exist");
        assert.strictEqual(serverSocket.data.telegramUserId, null);

        socket.disconnect();
    } finally {
        await harness.shutdown();
    }
});

test("R17.9T.6-B #2: valid initData → accepted with validated telegramUserId", async () => {
    const harness = await createAuthHarness({
        telegramAuth: { botToken: TEST_BOT_TOKEN }
    });

    try {
        const socket = await connectClient(harness.port, {
            telegramInitData: buildValidInitData()
        });

        const serverSocket = harness.socketGateway.getIO().sockets.sockets.get(
            socket.id
        );

        assert.ok(serverSocket, "server-side socket must exist");
        assert.strictEqual(serverSocket.data.telegramUserId, TELEGRAM_USER_ID);

        socket.disconnect();
    } finally {
        await harness.shutdown();
    }
});

test("R17.9T.6-B #3: invalid signature → connection rejected", async () => {
    const harness = await createAuthHarness({
        telegramAuth: { botToken: TEST_BOT_TOKEN }
    });

    try {
        const fields = {
            user: TEST_USER,
            auth_date: String(TEST_AUTH_DATE),
            query_id: "AAF9E7C6TEST"
        };
        const realHash = computeHash(fields, TEST_BOT_TOKEN);
        const flipped = (realHash[0] === "0" ? "1" : "0") + realHash.slice(1);

        await assertRejected(harness.port, {
            telegramInitData: buildSignedInitData({ ...fields, hash: flipped })
        });
    } finally {
        await harness.shutdown();
    }
});

test("R17.9T.6-B #4: expired initData → connection rejected", async () => {
    const harness = await createAuthHarness({
        telegramAuth: {
            botToken: TEST_BOT_TOKEN,
            maxAgeSeconds: 60
        }
    });

    try {
        const expiredInitData = buildSignedInitData({
            user: TEST_USER,
            auth_date: String(EXPIRED_AUTH_DATE),
            query_id: "AAF9E7C6TEST"
        });

        await assertRejected(harness.port, {
            telegramInitData: expiredInitData
        });
    } finally {
        await harness.shutdown();
    }
});

test("R17.9T.6-B #5: malformed initData → connection rejected", async () => {
    const harness = await createAuthHarness({
        telegramAuth: { botToken: TEST_BOT_TOKEN }
    });

    try {
        // Missing hash entirely.
        await assertRejected(harness.port, {
            telegramInitData: buildSignedInitData({
                user: TEST_USER,
                auth_date: String(TEST_AUTH_DATE),
                query_id: "AAF9E7C6TEST",
                hash: null
            })
        });

        // Garbage string without any query structure.
        await assertRejected(harness.port, {
            telegramInitData: "not-a-valid-init-data-string"
        });
    } finally {
        await harness.shutdown();
    }
});

test("R17.9T.6-B #6: two independent sockets with same valid identity → both accepted, same telegramUserId", async () => {
    const harness = await createAuthHarness({
        telegramAuth: { botToken: TEST_BOT_TOKEN }
    });

    try {
        const initData = buildValidInitData();

        const socketA = await connectClient(harness.port, { telegramInitData: initData });
        const socketB = await connectClient(harness.port, { telegramInitData: initData });

        const serverA = harness.socketGateway.getIO().sockets.sockets.get(socketA.id);
        const serverB = harness.socketGateway.getIO().sockets.sockets.get(socketB.id);

        assert.ok(serverA && serverB, "both sockets must exist");
        assert.notStrictEqual(socketA.id, socketB.id, "sockets are independent");
        assert.strictEqual(serverA.data.telegramUserId, TELEGRAM_USER_ID);
        assert.strictEqual(serverB.data.telegramUserId, TELEGRAM_USER_ID);

        socketA.disconnect();
        socketB.disconnect();
    } finally {
        await harness.shutdown();
    }
});

test("R17.9T.6-B #7: invalid credentials never produce an authenticated telegramUserId", async () => {
    const harness = await createAuthHarness({
        telegramAuth: { botToken: TEST_BOT_TOKEN }
    });

    try {
        // Wrong-signature attempt is rejected outright...
        await assertRejected(harness.port, {
            telegramInitData: buildSignedInitData({
                user: TEST_USER,
                auth_date: String(TEST_AUTH_DATE),
                query_id: "AAF9E7C6TEST",
                hash: computeHash(
                    {
                        user: TEST_USER,
                        auth_date: String(TEST_AUTH_DATE),
                        query_id: "AAF9E7C6TEST"
                    },
                    WRONG_BOT_TOKEN
                )
            })
        });

        // ...and no connected socket carries an authenticated identity.
        for (const [, serverSocket] of harness.socketGateway.getIO().sockets.sockets) {
            assert.notStrictEqual(
                typeof serverSocket.data.telegramUserId,
                "number",
                "no socket may hold an authenticated telegramUserId after invalid credentials"
            );
        }

        // A subsequent clean Web connection still works (no poisoning).
        const webSocket = await connectClient(harness.port);
        const serverWeb = harness.socketGateway.getIO().sockets.sockets.get(webSocket.id);
        assert.strictEqual(serverWeb.data.telegramUserId, null);
        webSocket.disconnect();
    } finally {
        await harness.shutdown();
    }
});