import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

import { EventBus } from "../../events/EventBus.js";
import { ROOM_LIFETIME_MS, ROOM_WALLET_POOL_SIZE } from "../../payment/RoomPaymentConstants.js";
import { LEDGER_ENTRY_KIND } from "../../payment/ledger/LedgerConstants.js";
import { buildPaymentRuntime } from "../../payment/runtime/PaymentRuntimeFactory.js";
import { bindPaymentRuntimeToApplication } from "../../payment/runtime/PaymentApplicationBinder.js";
import { DESCRIPTOR_STAKE_RELATION } from "../../payment/runtime/RoomPaymentSessionAdapter.js";
import { SyntheticTonSettlementEvidenceProvider } from "../helpers/syntheticTonSettlementEvidence.js";
import { LoggerService } from "../../services/LoggerService.js";
import { PlayerManager } from "../../managers/PlayerManager.js";
import { RoomManager } from "../../managers/RoomManager.js";
import { GameplayContextResolver } from "../../socket/GameplayContextResolver.js";
import { RoomLobbyBridge } from "../../socket/RoomLobbyBridge.js";
import { SetupSessionLifecycle } from "../../gameplay/SetupSessionLifecycle.js";
import { SocketGateway } from "../../socket/SocketGateway.js";
import {
    LOBBY_CLIENT_EVENTS,
    LOBBY_SERVER_EVENTS
} from "../../socket/lobbyProtocol.js";
import { GAME_MESSAGE_CHANNEL } from "../../socket/events.js";
import { LIVE_PAYMENT_ACCEPTANCE_ENABLED } from "../../payment/PaymentLifecycleAvailability.js";
import { io } from "socket.io-client";

const BASE_MS = 1_700_100_000_000;
const CREATED_AT = BASE_MS;
const NOW_MS = BASE_MS + 5_000;
const TRANSFER_SECONDS = Math.floor(NOW_MS / 1_000);
const SYNTHETIC_API_KEY = "SYNTHETIC-TONCENTER-TEST-KEY-NOT-REAL";
const MAX_PLAYERS = 3;
const CONNECT_TIMEOUT_MS = 10000;
const WAIT_TIMEOUT_MS = 10000;

const TOTAL_SECTIONS = 9;
let assertions = 0;
let sections = 0;

function check(value, message) {

    assert.ok(value, message);

    assertions += 1;

}

function equal(actual, expected, message) {

    assert.equal(actual, expected, message);

    assertions += 1;

}

function deepEqual(actual, expected, message) {

    assert.deepEqual(actual, expected, message);

    assertions += 1;

}

async function section(name, callback) {

    const before = assertions;

    await callback();

    sections += 1;

    process.stdout.write(`[${sections}/${TOTAL_SECTIONS}] PASS ${name} (${assertions - before} assertions)\n`);

}

function crc16Xmodem(bytes) {

    let register = 0;

    for (const byte of bytes) {

        register ^= byte << 8;

        for (let bit = 0; bit < 8; bit += 1) {

            register = (register & 0x8000) ? ((register << 1) ^ 0x1021) : (register << 1);

            register &= 0xffff;

        }

    }

    return Buffer.from([register >> 8, register & 0xff]);

}

function syntheticAddress(seed) {

    const hash = createHash("sha256").update(`page4-reconnect:${seed}`).digest();

    const body = Buffer.concat([Buffer.from([0x11, 0]), hash]);

    return Buffer.concat([body, crc16Xmodem(body)]).toString("base64url");

}

function writeCatalog(root) {

    const configDir = join(root, "config");

    mkdirSync(configDir, { recursive: true });

    const catalogPath = join(configDir, "synthetic-public-wallets.json");

    const wallets = Array.from({ length: ROOM_WALLET_POOL_SIZE }, (_, index) => ({

        roomNumber: index + 1,

        address: syntheticAddress(`wallet-${index + 1}`),

        publicKey: null,

        workchain: 0,

        network: "testnet"

    }));

    writeFileSync(catalogPath, `${JSON.stringify(wallets)}\n`, "utf8");

    return catalogPath;

}

function makeTemp() {

    const root = mkdtempSync(join(tmpdir(), "wheelwin-page4-reconnect-socketio-"));

    return {

        root,

        catalogPath: writeCatalog(root),

        cleanup: () => rmSync(root, { recursive: true, force: true })

    };

}

function buildRuntime(root, catalogPath) {

    const state = { payload: { transactions: [], address_book: {} } };

    const evidence = new SyntheticTonSettlementEvidenceProvider({ nowProvider: () => NOW_MS });

    const runtime = buildPaymentRuntime({

        dataDir: join(root, "payment-data"),

        network: "testnet",

        walletCatalogPath: catalogPath,

        nowProvider: () => NOW_MS,

        logger: null,

        fetchImpl: async () => ({ status: 200, json: async () => state.payload }),

        apiKeyProvider: () => SYNTHETIC_API_KEY,

        settlementEvidenceProvider: evidence

    });

    runtime.initialize();

    return {

        runtime,

        setPayload: (payload) => { state.payload = payload; }

    };

}

function emptyPayload(...transactions) {

    return { transactions, address_book: {} };

}

function transactionFor(intent, wallet, overrides = {}) {

    const body = {

        account: wallet.address,

        hash: createHash("sha256")

            .update(`${intent.paymentReference}:${overrides.suffix ?? "transaction"}`)

            .digest("hex"),

        now: overrides.nowSeconds ?? TRANSFER_SECONDS,

        description: { aborted: false, compute_ph: { success: true }, action: { success: true } },

        in_msg: {

            source: overrides.source ?? intent.expectedSender,

            destination: wallet.address,

            value: String(overrides.amountAtomic ?? intent.amountAtomic),

            message_content: {

                decoded: {

                    type: "text_comment",

                    comment: `WW1:${intent.paymentReference}`

                }

            }

        }

    };

    return body;

}

function connectClient(url) {

    return new Promise((resolve, reject) => {

        const socket = io(url, { transports: ["websocket"], forceNew: true });

        const timer = setTimeout(() => {

            try { socket.close(); } catch { }

            reject(new Error("client connect timeout"));

        }, CONNECT_TIMEOUT_MS);

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

function waitForEvent(socket, eventName, timeoutMs = WAIT_TIMEOUT_MS) {

    return new Promise((resolve, reject) => {

        const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${eventName}`)), timeoutMs);

        socket.once(eventName, (payload) => {

            clearTimeout(timer);

            resolve(payload);

        });

    });

}

function waitForGameMessage(socket, type, timeoutMs = WAIT_TIMEOUT_MS) {

    return new Promise((resolve, reject) => {

        const timer = setTimeout(() => reject(new Error(`Timed out waiting for game message ${type}`)), timeoutMs);

        const handler = (message) => {

            if (message && message.type === type) {

                clearTimeout(timer);

                socket.off(GAME_MESSAGE_CHANNEL, handler);

                resolve(message);

            }

        };

        socket.on(GAME_MESSAGE_CHANNEL, handler);

    });

}

function waitFor(predicate, timeoutMs = 5000, intervalMs = 20) {

    const deadline = Date.now() + timeoutMs;

    return new Promise((resolve, reject) => {

        const tick = () => {

            try {

                if (predicate()) {

                    resolve();

                    return;

                }

            } catch (error) {

                reject(error);

                return;

            }

            if (Date.now() >= deadline) {

                reject(new Error("waitFor timed out"));

                return;

            }

            setTimeout(tick, intervalMs);

        };

        tick();

    });

}

async function buildSocketHarness(root, catalogPath) {

    const { runtime, setPayload } = buildRuntime(root, catalogPath);

    const logger = new LoggerService({ logLevel: "error" });

    logger.initialize();

    const eventBus = new EventBus({

        logger,

        eventBusConfig: { logEvents: false, showDebugPanel: false }

    });

    eventBus.initialize();

    const playerManager = new PlayerManager({ logger, eventBus });

    playerManager.initialize();

    const roomManager = new RoomManager({

        logger,

        eventBus,

        roomConfig: { maxPlayers: MAX_PLAYERS }

    });

    roomManager.initialize();

    const setupSessionLifecycle = new SetupSessionLifecycle({ logger, eventBus, roomManager });

    setupSessionLifecycle.initialize();

    roomManager.attachSetupSessionLifecycle(setupSessionLifecycle);

    const gameplayContextResolver = new GameplayContextResolver({ logger, playerManager, roomManager });

    const roomLobbyBridge = new RoomLobbyBridge({

        logger,

        eventBus,

        roomManager,

        playerManager,

        gameplayContextResolver,

        setupSessionLifecycle,

        telegramIdentityResolver: (socketId) => `tg:${socketId}`,

        isDevelopment: true

    });

    roomLobbyBridge.initialize();

    const binding = bindPaymentRuntimeToApplication(runtime, {

        roomManager,

        logger: null,

        paymentAcceptanceEnabled: true

    });

    roomLobbyBridge.configurePaymentApplicationBinding(binding);

    const httpServer = http.createServer();

    const socketGateway = new SocketGateway({

        logger,

        socketConfig: { cors: { origin: "*" } },

        eventBus,

        gameplayContextResolver,

        recoveryEngine: {},

        roomLobbyBridge,

        devMode: true

    });

    socketGateway.initialize(httpServer);

    socketGateway.connectEventBus(eventBus);

    await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));

    const port = httpServer.address().port;

    const url = `http://127.0.0.1:${port}`;

    return {

        url,

        httpServer,

        socketGateway,

        roomLobbyBridge,

        roomManager,

        playerManager,

        eventBus,

        logger,

        runtime,

        setPayload,

        binding,

        setupSessionLifecycle,

        async shutdown() {

            await socketGateway.shutdown();

            await new Promise((resolve) => httpServer.close(resolve));

            roomLobbyBridge.shutdown();

            setupSessionLifecycle.shutdown();

            roomManager.shutdown();

            playerManager.shutdown();

            eventBus.shutdown();

            logger.shutdown();

            runtime.shutdown();

        }

    };

}

async function expectPaymentStatus(socket, {

    roomId,

    playerId,

    paymentReference,

    amountAtomic,

    walletAddress,

    status,

    deadline

}) {

    const payload = await waitForEvent(socket, LOBBY_SERVER_EVENTS.ENTRY_PAYMENT_SESSION_UPDATED);

    equal(payload.roomId, roomId, "status payload carries the room id");

    equal(payload.playerId, playerId, "status payload carries the player id");

    equal(payload.status, status, "status payload carries the expected status");

    equal(payload.paymentAcceptanceEnabled, false, "status payload carries acceptance flag false");

    equal(payload.paymentReference, paymentReference, "status payload carries the payment reference");

    equal(payload.amountAtomic, amountAtomic, "status payload carries the amount");

    equal(payload.destinationWalletAddress, walletAddress, "status payload carries the assigned wallet address");

    equal(payload.expiresAt, deadline, "status payload carries the original room deadline");

    equal(payload.network, "testnet", "status payload carries testnet");

    equal(payload.asset, "TON", "status payload carries TON");

    equal(payload.reason, null, "status payload carries no failure reason");

    return payload;

}

function principalEntryCount(runtime, roomId) {

    return runtime.ledger.store.listForRoom(roomId).filter((entry) => entry.kind === LEDGER_ENTRY_KIND.INCOMING_PRINCIPAL).length;

}

async function run() {

    await section("live payment acceptance stays disabled and production unchanged", () => {

        equal(LIVE_PAYMENT_ACCEPTANCE_ENABLED, false, "module constant remains false");

    });

    let harness;

    const sockets = [];

    const t = makeTemp();

    try {

        harness = await buildSocketHarness(t.root, t.catalogPath);

        const { url, roomLobbyBridge, roomManager, runtime, setPayload, socketGateway } = harness;

        let roomId;

        let player1;

        let player2;

        let player3;

        let walletAddress;

        let deadline;

        let ref0;

        let ref1;

        let ref2;

        let credential1;

        const sockets = [];

        await section("initial socket binds to creator player and room; two more players join over real sockets", async () => {

            const socketA = await connectClient(url);

            sockets.push(socketA);

            socketA.emit(LOBBY_CLIENT_EVENTS.CREATE_ROOM);

            const created = await waitForEvent(socketA, LOBBY_SERVER_EVENTS.ROOM_CREATED);

            equal(typeof created.roomId === "string" && created.roomId.length > 0, true, "create room returns a room id");

            equal(typeof created.playerId === "string" && created.playerId.length > 0, true, "create room binds the creator to a player");

            equal(typeof created.recoveryCredential === "string" && created.recoveryCredential.length > 0, true, "create room issues a recovery credential");

            roomId = created.roomId;

            player1 = created.playerId;

            credential1 = created.recoveryCredential;

            const socketB = await connectClient(url);

            sockets.push(socketB);

            socketB.emit(LOBBY_CLIENT_EVENTS.JOIN_ROOM, roomId);

            const joinedB = await waitForEvent(socketB, LOBBY_SERVER_EVENTS.ROOM_JOINED);

            player2 = joinedB.playerId;

            equal(joinedB.roomId, roomId, "player2 joins the same room");

            const socketC = await connectClient(url);

            sockets.push(socketC);

            socketC.emit(LOBBY_CLIENT_EVENTS.JOIN_ROOM, roomId);

            const joinedC = await waitForEvent(socketC, LOBBY_SERVER_EVENTS.ROOM_JOINED);

            player3 = joinedC.playerId;

            equal(joinedC.roomId, roomId, "player3 joins the same room");

            equal(new Set([player1, player2, player3]).size, MAX_PLAYERS, "three distinct players");

            equal(roomManager.getRoom(roomId).players.length, MAX_PLAYERS, "room is full with three players");

            equal(roomManager.getRoom(roomId).players.includes(player1), true, "creator player is registered in the room");

        });

        await section("server prepares the room payment session and the initial socket receives its status over the real event path", async () => {

            const socketA = sockets[0];

            const requiredPlayers = [

                {

                    roomId,

                    playerId: player1,

                    paymentReference: "WW-P4-0",

                    expectedSender: syntheticAddress("p4-sender-0"),

                    amountAtomic: 1_000_000_000

                },

                {

                    roomId,

                    playerId: player2,

                    paymentReference: "WW-P4-1",

                    expectedSender: syntheticAddress("p4-sender-1"),

                    amountAtomic: 2_000_000_000

                },

                {

                    roomId,

                    playerId: player3,

                    paymentReference: "WW-P4-2",

                    expectedSender: syntheticAddress("p4-sender-2"),

                    amountAtomic: 3_000_000_000

                }

            ];

            ref0 = requiredPlayers[0].paymentReference;

            ref1 = requiredPlayers[1].paymentReference;

            ref2 = requiredPlayers[2].paymentReference;

            deadline = CREATED_AT + ROOM_LIFETIME_MS;

            await runtime.sessionAdapter.prepareRoom({

                roomId,

                roomCreatedAt: CREATED_AT,

                network: "testnet",

                asset: "TON",

                stakeLedgerRelation: DESCRIPTOR_STAKE_RELATION,

                requiredPlayers

            });

            const wallet = runtime.paymentService.getWalletForRoom(roomId);

            walletAddress = wallet.address;

            equal(runtime.paymentService.listPaymentIntentsForRoom(roomId).length, MAX_PLAYERS, "three payment intents created");

            equal(runtime.paymentService.getPaymentIntent(ref0).playerId, player1, "intent 0 belongs to player1");

            equal(runtime.paymentService.getPaymentIntent(ref1).playerId, player2, "intent 1 belongs to player2");

            equal(runtime.paymentService.getPaymentIntent(ref2).playerId, player3, "intent 2 belongs to player3");

            socketA.emit(LOBBY_CLIENT_EVENTS.PAYMENT_STATUS_REQUEST);

            const initial = await expectPaymentStatus(socketA, {

                roomId,

                playerId: player1,

                paymentReference: ref0,

                amountAtomic: 1_000_000_000,

                walletAddress,

                status: "AWAITING_PAYMENT",

                deadline

            });

            equal(initial.playerId, player1, "initial status is delivered to the socket bound to player1");

            equal(initial.roomId, roomId, "initial status carries the expected room id");

        });

        await section("the socket disconnects; invalid recovery claims fail; valid recovery rebinds the same player and room", async () => {

            const socketA = sockets[0];

            socketA.disconnect();

            await waitFor(() => socketGateway.getIO().sockets.sockets.has(socketA.id) === false, 5000);

            const socketD = await connectClient(url);

            sockets.push(socketD);

            socketD.emit(GAME_MESSAGE_CHANNEL, {

                type: "SESSION_RECOVERY_REQUEST",

                payload: { playerId: player1, roomId: "room-does-not-exist", recoveryCredential: credential1 }

            });

            const failedD = await waitForGameMessage(socketD, "SESSION_RECOVERY_FAILED");

            equal(failedD.payload.roomId, "room-does-not-exist", "wrong-room failure carries the claimed room id");

            check(typeof failedD.payload.reason === "string" && failedD.payload.reason.length > 0, "wrong-room recovery is rejected with a reason");

            const socketE = await connectClient(url);

            sockets.push(socketE);

            socketE.emit(GAME_MESSAGE_CHANNEL, {

                type: "SESSION_RECOVERY_REQUEST",

                payload: { playerId: player2, roomId: roomId, recoveryCredential: credential1 }

            });

            const failedE = await waitForGameMessage(socketE, "SESSION_RECOVERY_FAILED");

            equal(failedE.payload.playerId, player2, "wrong-player failure carries the claimed player id");

            check(typeof failedE.payload.reason === "string" && failedE.payload.reason.length > 0, "wrong-player recovery is rejected with a reason");

            const socketF = await connectClient(url);

            sockets.push(socketF);

            const observed = [];

            socketF.on(GAME_MESSAGE_CHANNEL, (message) => observed.push({ channel: GAME_MESSAGE_CHANNEL, message }));

            socketF.on(LOBBY_SERVER_EVENTS.SETUP_SESSION_SYNC, (payload) => observed.push({ event: LOBBY_SERVER_EVENTS.SETUP_SESSION_SYNC, payload }));

            socketF.emit(GAME_MESSAGE_CHANNEL, {

                type: "SESSION_RECOVERY_REQUEST",

                payload: { playerId: player1, roomId: roomId, recoveryCredential: credential1 }

            });

            await waitFor(() => observed.length > 0, 5000);

            const sync = observed.find((item) => item.event === LOBBY_SERVER_EVENTS.SETUP_SESSION_SYNC);

            check(sync, "recovered socket receives setup session sync");
        });

        await section("the recovered socket receives the authoritative payment status with unchanged reference, wallet, and deadline", async () => {

            const socketF = sockets[sockets.length - 1];

            const section5Observed = [];

            socketF.on(LOBBY_SERVER_EVENTS.ENTRY_PAYMENT_SESSION_UPDATED, (payload) => section5Observed.push(payload));

            socketF.emit(LOBBY_CLIENT_EVENTS.PAYMENT_STATUS_REQUEST);

            await waitFor(() => section5Observed.length > 0, 5000);

            const recovered = section5Observed[0];

            check(recovered, "recovered socket receives a payment status");

            equal(recovered.playerId, player1, "recovered socket is bound to the original player");

            equal(recovered.roomId, roomId, "recovered socket is bound to the original room");

            equal(recovered.paymentReference, ref0, "payment reference is unchanged after reconnect");

            equal(recovered.amountAtomic, 1_000_000_000, "amount is unchanged after reconnect");

            equal(recovered.destinationWalletAddress, walletAddress, "assigned destination wallet is unchanged after reconnect");

            equal(recovered.expiresAt, deadline, "original room deadline is unchanged after reconnect");

            equal(recovered.status, "AWAITING_PAYMENT", "recovered status is AWAITING_PAYMENT");

            equal(recovered.paymentAcceptanceEnabled, false, "recovered status carries acceptance flag false");

        });

        await section("reconnect and status redelivery create no duplicate intents, wallet reservations, or principal entries", async () => {

            equal(runtime.paymentService.listPaymentIntentsForRoom(roomId).length, MAX_PLAYERS, "intent count unchanged after reconnect");

            equal(runtime.paymentService.getWalletForRoom(roomId).address, walletAddress, "wallet assignment unchanged after reconnect");

            equal(principalEntryCount(runtime, roomId), 0, "no incoming principal entries before settlement");

        });

        await section("a mismatched player cannot consume another player's payment status", async () => {

            const socketC = sockets[2];

            socketC.emit(LOBBY_CLIENT_EVENTS.PAYMENT_STATUS_REQUEST);

            const payload = await waitForEvent(socketC, LOBBY_SERVER_EVENTS.ENTRY_PAYMENT_SESSION_UPDATED);

            equal(payload.playerId, player3, "player3 socket receives its own payment status");

            equal(payload.paymentReference, ref2, "player3 status carries player3's reference");

            equal(payload.amountAtomic, 3_000_000_000, "player3 status carries player3's amount");

            equal(payload.paymentAcceptanceEnabled, false, "player3 status carries acceptance flag false");

            check(payload.playerId !== player1, "player3 socket cannot consume player1's payment status");

        });

        await section("a SETTLED display for one player does not satisfy the three-player game-start gate", async () => {

            const socketF = sockets[sockets.length - 1];

            const intent1 = runtime.paymentService.getPaymentIntent(ref0);

            const wallet = runtime.paymentService.getWalletForRoom(roomId);

            setPayload(emptyPayload(transactionFor(intent1, wallet)));

            await runtime.sessionAdapter.observeRoomPayments({ roomId });

            const section8Observed = [];

            socketF.on(LOBBY_SERVER_EVENTS.ENTRY_PAYMENT_SESSION_UPDATED, (payload) => section8Observed.push(payload));

            socketF.emit(LOBBY_CLIENT_EVENTS.PAYMENT_STATUS_REQUEST);

            await waitFor(() => section8Observed.length > 0, 5000);

            const settled1 = section8Observed[0];

            check(settled1, "player1 status reports SETTLED after settlement");

            equal(settled1.playerId, player1, "settled status carries player1");

            equal(settled1.status, "SETTLED", "settled intent reports SETTLED");

            equal(settled1.paymentReference, ref0, "settled status carries the payment reference");

            equal(settled1.destinationWalletAddress, walletAddress, "settled status carries the assigned wallet");

            equal(settled1.expiresAt, deadline, "settled status carries the original room deadline");

            equal(settled1.paymentAcceptanceEnabled, false, "settled status carries acceptance flag false");

            const gate1 = runtime.paymentGate.getGameStartGateStatus(roomId, [player1, player2, player3]);

            equal(gate1.eligible, false, "one settled payment of three does not open the gate");

            const intent2 = runtime.paymentService.getPaymentIntent(ref1);

            setPayload(emptyPayload(transactionFor(intent2, wallet)));

            await runtime.sessionAdapter.observeRoomPayments({ roomId });

            const gate2 = runtime.paymentGate.getGameStartGateStatus(roomId, [player1, player2, player3]);

            equal(gate2.eligible, false, "two settled payments of three do not open the gate");

            const intent3 = runtime.paymentService.getPaymentIntent(ref2);

            setPayload(emptyPayload(transactionFor(intent3, wallet)));

            await runtime.sessionAdapter.observeRoomPayments({ roomId });

            const gate3 = runtime.paymentGate.getGameStartGateStatus(roomId, [player1, player2, player3]);

            equal(gate3.eligible, true, "all three settled payments open the gate");

        });

        await section("final state has no duplicated intents or principal entries; acceptance flag stays off", async () => {

            equal(runtime.paymentService.listPaymentIntentsForRoom(roomId).length, MAX_PLAYERS, "still exactly three intents after redelivery and settlement");

            equal(principalEntryCount(runtime, roomId), MAX_PLAYERS, "exactly three incoming principal entries after settlement");

            equal(runtime.paymentService.getWalletForRoom(roomId).address, walletAddress, "wallet unchanged after settlement");

            equal(LIVE_PAYMENT_ACCEPTANCE_ENABLED, false, "live payment acceptance remains disabled after the test");

        });

    } finally {

        if (harness) {

            try {

                for (const socket of sockets) {

                    try { socket.disconnect(); } catch { }

                }

                await harness.shutdown();

            } catch (shutdownError) {

                process.stdout.write(`shutdown error: ${String(shutdownError)}\n`);

            }

        }

        t.cleanup();

    }

}

run().then(() => {

    setTimeout(() => process.exit(0), 100).unref();

}).catch((error) => {

    console.error(error);

    process.exit(1);

});
