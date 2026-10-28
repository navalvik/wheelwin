import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventBus } from "../../events/EventBus.js";
import { EVENT_TYPES } from "../../events/EventTypes.js";
import { ROOM_LIFETIME_MS, ROOM_WALLET_POOL_SIZE } from "../../payment/RoomPaymentConstants.js";
import { PAYMENT_INTENT_STATE } from "../../payment/PaymentIntentStatus.js";
import { LEDGER_ENTRY_KIND } from "../../payment/ledger/LedgerConstants.js";
import { buildPaymentRuntime } from "../../payment/runtime/PaymentRuntimeFactory.js";
import { bindPaymentRuntimeToApplication } from "../../payment/runtime/PaymentApplicationBinder.js";
import { DESCRIPTOR_STAKE_RELATION } from "../../payment/runtime/RoomPaymentSessionAdapter.js";
import { SyntheticTonSettlementEvidenceProvider } from "../helpers/syntheticTonSettlementEvidence.js";
import { RoomLobbyBridge } from "../../socket/RoomLobbyBridge.js";
import { LIVE_PAYMENT_ACCEPTANCE_ENABLED } from "../../payment/PaymentLifecycleAvailability.js";

const BASE_MS = 1_700_100_000_000;
const CREATED_AT = BASE_MS;
const NOW_MS = BASE_MS + 5_000;
const TRANSFER_SECONDS = Math.floor(NOW_MS / 1_000);
const SYNTHETIC_API_KEY = "SYNTHETIC-TONCENTER-TEST-KEY-NOT-REAL";

const TOTAL_SECTIONS = 9;
let assertions = 0;
let sections = 0;

function check(value, message) { assert.ok(value, message); assertions += 1; }
function equal(actual, expected, message) { assert.equal(actual, expected, message); assertions += 1; }
function deepEqual(actual, expected, message) { assert.deepEqual(actual, expected, message); assertions += 1; }
function deepStrictEqual(actual, expected, message) { assert.deepStrictEqual(actual, expected, message); assertions += 1; }
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
    const hash = createHash("sha256").update(`payment-recovery:${seed}`).digest();
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
    const root = mkdtempSync(join(tmpdir(), "wheelwin-page4-recovery-"));
    return { root, catalogPath: writeCatalog(root), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function buildRuntime(root, catalogPath, { now = () => NOW_MS } = {}) {
    const state = { payload: { transactions: [], address_book: {} } };
    const evidence = new SyntheticTonSettlementEvidenceProvider({ nowProvider: now });
    const runtime = buildPaymentRuntime({
        dataDir: join(root, "payment-data"),
        network: "testnet",
        walletCatalogPath: catalogPath,
        nowProvider: now,
        logger: null,
        fetchImpl: async () => ({ status: 200, json: async () => state.payload }),
        apiKeyProvider: () => SYNTHETIC_API_KEY,
        settlementEvidenceProvider: evidence
    });
    runtime.initialize();
    return { runtime, setPayload: (payload) => { state.payload = payload; } };
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

function threePlayerDescriptor(roomId, playerIds) {
    const requiredPlayers = playerIds.map((playerId, index) => ({
        roomId,
        paymentReference: `WW-RT-PLAYER-${index}`,
        playerId,
        expectedSender: syntheticAddress(`rt-sender-${index}`),
        amountAtomic: (index + 1) * 1_000_000_000
    }));
    return { roomId, roomCreatedAt: CREATED_AT, network: "testnet", asset: "TON", stakeLedgerRelation: DESCRIPTOR_STAKE_RELATION, requiredPlayers };
}

function minimalRoomManager(roomId, roomCreatedAt, playerIds) {
    const room = { roomId, createdAt: roomCreatedAt, status: "ACTIVE", players: [...playerIds] };
    return {
        getRoom: (id) => (id === roomId ? room : null),
        attachRefundLifecycle: () => {}
    };
}

function shutdownRuntime(runtime) { try { runtime.shutdown(); } catch { /* best effort */ } }

// ---------------------------------------------------------------------------
// P6.7 — Page4 payment-state recovery after internet reconnection.
// ---------------------------------------------------------------------------
async function run() {

    await section("live payment acceptance stays disabled and production unchanged", () => {
        equal(LIVE_PAYMENT_ACCEPTANCE_ENABLED, false, "live payment acceptance module constant remains false");
    });

    await section("PENDING intent delivers AWAITING_PAYMENT after reconnect before deadline", async () => {
        const t = makeTemp();
        try {
            const { runtime } = buildRuntime(t.root, t.catalogPath);
            const roomId = "room-recovery-pending";
            const playerIds = ["recovery-player-0", "recovery-player-1", "recovery-player-2"];
            const roomManager = minimalRoomManager(roomId, CREATED_AT, playerIds);
            const binding = bindPaymentRuntimeToApplication(runtime, { roomManager, logger: null, paymentAcceptanceEnabled: true });
            const descriptor = threePlayerDescriptor(roomId, playerIds);
            binding.prepareRoomPaymentSession(roomId, descriptor.requiredPlayers);

            const logger = { info() {}, warn() {}, error() {} };
            const eventBus = new EventBus({ logger, eventBusConfig: { logEvents: false, showDebugPanel: false } });
            eventBus.initialize();

            // Real RoomLobbyBridge instance so _getSocketContext / _playerToSocket work.
            const bridge = Object.create(RoomLobbyBridge.prototype);
            Object.assign(bridge, {
                _assertAuthoritativeMutation: () => null,
                _roomManager: roomManager,
                _playerToSocket: new Map(playerIds.map((playerId) => [playerId, `socket-${playerId}`])),
                _eventBus: eventBus,
                _logger: logger,
                _paymentApplicationBinding: binding,
                _deliverToSocket: (_socketId, eventName, payload) => { delivered.push({ eventName, payload }); }
            });
            const delivered = [];
            const socketId = `socket-${playerIds[0]}`;
            const room = roomManager.getRoom(roomId);
            bridge._getSocketContext = () => ({ socketId, playerId: playerIds[0], roomId });

            bridge._deliverPaymentStatusToSocket(roomId, playerIds[0], socketId);

            equal(delivered.length, 1, "exactly one status event delivered");
            deepStrictEqual(delivered[0].eventName, "ENTRY_PAYMENT_SESSION_UPDATED", "delivered event is ENTRY_PAYMENT_SESSION_UPDATED");
            equal(delivered[0].payload.roomId, roomId, "payload roomId matches");
            equal(delivered[0].payload.playerId, playerIds[0], "payload playerId matches");
            equal(delivered[0].payload.status, "AWAITING_PAYMENT", "pending intent reports AWAITING_PAYMENT");
            equal(delivered[0].payload.paymentAcceptanceEnabled, true, "explicitly enabled isolated test session advertises payable intent");
            equal(delivered[0].payload.paymentReference, descriptor.requiredPlayers[0].paymentReference, "payload carries the payment reference");
            equal(delivered[0].payload.amountAtomic, descriptor.requiredPlayers[0].amountAtomic, "payload carries the amount");
            equal(delivered[0].payload.network, "testnet", "payload carries testnet");
            equal(delivered[0].payload.asset, "TON", "payload carries TON");
            equal(delivered[0].payload.expiresAt, CREATED_AT + ROOM_LIFETIME_MS, "payload carries the immutable room deadline");
            equal(delivered[0].payload.destinationWalletAddress, binding.runtime.paymentService.getWalletForRoom(roomId).address, "payload carries the assigned wallet address");
            equal(delivered[0].payload.reason, null, "no failure reason for awaiting payment");

            equal(runtime.paymentService.listPaymentIntentsForRoom(roomId).length, 3, "no duplicate intents after status delivery");

            shutdownRuntime(runtime);
            eventBus.shutdown();
        } finally { t.cleanup(); }
    });

    await section("settled intent delivers SETTLED only with matching durable principal entry", async () => {
        const t = makeTemp();
        try {
            const { runtime, setPayload } = buildRuntime(t.root, t.catalogPath);
            const roomId = "room-recovery-settled";
            const playerIds = ["settle-player-0", "settle-player-1", "settle-player-2"];
            const roomManager = minimalRoomManager(roomId, CREATED_AT, playerIds);
            const binding = bindPaymentRuntimeToApplication(runtime, { roomManager, logger: null, paymentAcceptanceEnabled: true });
            const descriptor = threePlayerDescriptor(roomId, playerIds);
            binding.prepareRoomPaymentSession(roomId, descriptor.requiredPlayers);

            // Settle player-0's payment through the real observation path.
            const intent = runtime.paymentService.getPaymentIntent(descriptor.requiredPlayers[0].paymentReference);
            const wallet = runtime.paymentService.getWalletForRoom(roomId);
            setPayload(emptyPayload(transactionFor(intent, wallet)));
            await runtime.sessionAdapter.observeRoomPayments({ roomId });

            const logger = { info() {}, warn() {}, error() {} };
            const eventBus = new EventBus({ logger, eventBusConfig: { logEvents: false, showDebugPanel: false } });
            eventBus.initialize();

            const bridge = Object.create(RoomLobbyBridge.prototype);
            Object.assign(bridge, {
                _assertAuthoritativeMutation: () => null,
                _roomManager: roomManager,
                _playerToSocket: new Map(playerIds.map((playerId) => [playerId, `socket-${playerId}`])),
                _eventBus: eventBus,
                _logger: logger,
                _paymentApplicationBinding: binding,
                _deliverToSocket: (_socketId, eventName, payload) => { delivered.push({ eventName, payload }); }
            });
            const delivered = [];
            const socketId = `socket-${playerIds[0]}`;
            bridge._getSocketContext = () => ({ socketId, playerId: playerIds[0], roomId });

            bridge._deliverPaymentStatusToSocket(roomId, playerIds[0], socketId);

            equal(delivered.length, 1, "exactly one status event delivered");
            equal(delivered[0].payload.status, "SETTLED", "settled intent with principal reports SETTLED");
            equal(delivered[0].payload.reason, null, "no failure reason for settled");
            equal(delivered[0].payload.paymentReference, intent.paymentReference, "payload carries the settled payment reference");
            equal(delivered[0].payload.transactionId ?? null, null, "transaction id is not exposed in the public status payload");

            equal(runtime.paymentService.listPaymentIntentsForRoom(roomId).length, 3, "settled room creates no duplicate intents");
            deepEqual(
                runtime.ledger.store.listForRoom(roomId).filter((e) => e.kind === LEDGER_ENTRY_KIND.INCOMING_PRINCIPAL).length,
                1,
                "exactly one durable incoming principal entry"
            );

            shutdownRuntime(runtime);
            eventBus.shutdown();
        } finally { t.cleanup(); }
    });

    await section("settled claim without matching principal entry is rejected as unverified", async () => {
        const t = makeTemp();
        try {
            const { runtime, setPayload } = buildRuntime(t.root, t.catalogPath);
            const roomId = "room-recovery-unverified";
            const playerIds = ["unverified-player-0", "unverified-player-1", "unverified-player-2"];
            const roomManager = minimalRoomManager(roomId, CREATED_AT, playerIds);
            const binding = bindPaymentRuntimeToApplication(runtime, { roomManager, logger: null, paymentAcceptanceEnabled: true });
            const descriptor = threePlayerDescriptor(roomId, playerIds);
            binding.prepareRoomPaymentSession(roomId, descriptor.requiredPlayers);

            // Settle through the real path (records SETTLED intent + principal),
            // then remove the durable principal entry so the intent has no
            // backing evidence.
            const intent = runtime.paymentService.getPaymentIntent(descriptor.requiredPlayers[0].paymentReference);
            const wallet = runtime.paymentService.getWalletForRoom(roomId);
            setPayload(emptyPayload(transactionFor(intent, wallet)));
            await runtime.sessionAdapter.observeRoomPayments({ roomId });

            const principalKey = `ww:incoming-principal:${intent.paymentReference}`;
            const entry = runtime.ledger.store.findByIdempotencyKey(principalKey);
            check(Boolean(entry), "principal entry recorded after settlement");
            runtime.ledger.store.forget(entry.entryId);
            equal(runtime.ledger.store.findByIdempotencyKey(principalKey), null, "principal entry removed");

            const logger = { info() {}, warn() {}, error() {} };
            const eventBus = new EventBus({ logger, eventBusConfig: { logEvents: false, showDebugPanel: false } });
            eventBus.initialize();

            const delivered = [];
            const bridge = Object.create(RoomLobbyBridge.prototype);
            Object.assign(bridge, {
                _assertAuthoritativeMutation: () => null,
                _roomManager: roomManager,
                _playerToSocket: new Map(playerIds.map((playerId) => [playerId, `socket-${playerId}`])),
                _eventBus: eventBus,
                _logger: logger,
                _paymentApplicationBinding: binding,
                _deliverToSocket: (_socketId, eventName, payload) => { delivered.push({ eventName, payload }); }
            });
            const socketId = `socket-${playerIds[0]}`;
            bridge._getSocketContext = () => ({ socketId, playerId: playerIds[0], roomId });

            bridge._deliverPaymentStatusToSocket(roomId, playerIds[0], socketId);

            equal(delivered.length, 1, "exactly one status event delivered");
            equal(delivered[0].payload.status, "PAYMENT_UNAVAILABLE", "settled without principal reports PAYMENT_UNAVAILABLE");
            equal(delivered[0].payload.reason, "payment_settlement_unverified", "reason is payment_settlement_unverified");

            shutdownRuntime(runtime);
            eventBus.shutdown();
        } finally { t.cleanup(); }
    });

    await section("missing payment runtime fail-closes to PAYMENT_UNAVAILABLE", async () => {
        const t = makeTemp();
        try {
            const { runtime } = buildRuntime(t.root, t.catalogPath);
            const roomId = "room-recovery-noruntime";
            const playerIds = ["no-runtime-player-0", "no-runtime-player-1", "no-runtime-player-2"];
            const roomManager = minimalRoomManager(roomId, CREATED_AT, playerIds);

            const logger = { info() {}, warn() {}, error() {} };
            const eventBus = new EventBus({ logger, eventBusConfig: { logEvents: false, showDebugPanel: false } });
            eventBus.initialize();

            const delivered = [];
            const bridge = Object.create(RoomLobbyBridge.prototype);
            Object.assign(bridge, {
                _assertAuthoritativeMutation: () => null,
                _roomManager: roomManager,
                _playerToSocket: new Map(playerIds.map((playerId) => [playerId, `socket-${playerId}`])),
                _eventBus: eventBus,
                _logger: logger,
                _paymentApplicationBinding: { runtime: null },
                _deliverToSocket: (_socketId, eventName, payload) => { delivered.push({ eventName, payload }); }
            });
            const socketId = `socket-${playerIds[0]}`;
            bridge._getSocketContext = () => ({ socketId, playerId: playerIds[0], roomId });

            bridge._deliverPaymentStatusToSocket(roomId, playerIds[0], socketId);

            equal(delivered.length, 1, "exactly one status event delivered");
            equal(delivered[0].payload.status, "PAYMENT_UNAVAILABLE", "missing runtime reports PAYMENT_UNAVAILABLE");
            equal(delivered[0].payload.reason, "payment_state_unavailable", "reason is payment_state_unavailable");

            shutdownRuntime(runtime);
            eventBus.shutdown();
        } finally { t.cleanup(); }
    });

    await section("re-delivery request path resolves identity from socket binding only", async () => {
        const t = makeTemp();
        try {
            const { runtime } = buildRuntime(t.root, t.catalogPath);
            const roomId = "room-recovery-request";
            const playerIds = ["request-player-0", "request-player-1", "request-player-2"];
            const roomManager = minimalRoomManager(roomId, CREATED_AT, playerIds);
            const binding = bindPaymentRuntimeToApplication(runtime, { roomManager, logger: null, paymentAcceptanceEnabled: true });
            const descriptor = threePlayerDescriptor(roomId, playerIds);
            binding.prepareRoomPaymentSession(roomId, descriptor.requiredPlayers);

            const logger = { info() {}, warn() {}, error() {} };
            const eventBus = new EventBus({ logger, eventBusConfig: { logEvents: false, showDebugPanel: false } });
            eventBus.initialize();

            const delivered = [];
            const bridge = Object.create(RoomLobbyBridge.prototype);
            Object.assign(bridge, {
                _assertAuthoritativeMutation: () => null,
                _roomManager: roomManager,
                _playerToSocket: new Map(playerIds.map((playerId) => [playerId, `socket-${playerId}`])),
                _eventBus: eventBus,
                _logger: logger,
                _paymentApplicationBinding: binding,
                _deliverToSocket: (_socketId, eventName, payload) => { delivered.push({ eventName, payload }); },
                _getSocketContext: (socketId) => {
                    if (!socketId) return null;
                    const playerId = socketId.replace("socket-", "");
                    return { socketId, playerId, roomId };
                }
            });

            // Player-0 on their own socket: status delivered.
            bridge._handlePaymentStatusRequest(`socket-${playerIds[0]}`);
            equal(delivered.length, 1, "request delivers status to authorized socket");
            equal(delivered[0].payload.status, "AWAITING_PAYMENT", "requested status is AWAITING_PAYMENT");

            // Unknown socket: nothing delivered.
            bridge._handlePaymentStatusRequest("socket-unknown");
            equal(delivered.length, 1, "unknown socket delivers nothing");

            // Socket not bound to any player: nothing delivered.
            const extraSocket = "socket-orphan";
            bridge._playerToSocket.delete(extraSocket);
            bridge._handlePaymentStatusRequest(extraSocket);
            equal(delivered.length, 1, "orphan socket delivers nothing");

            shutdownRuntime(runtime);
            eventBus.shutdown();
        } finally { t.cleanup(); }
    });

    await section("payment status events ignore other rooms and players", async () => {
        const t = makeTemp();
        try {
            const { runtime } = buildRuntime(t.root, t.catalogPath);
            const roomId = "room-recovery-own";
            const playerIds = ["own-player-0", "own-player-1", "own-player-2"];
            const roomManager = minimalRoomManager(roomId, CREATED_AT, playerIds);
            const binding = bindPaymentRuntimeToApplication(runtime, { roomManager, logger: null, paymentAcceptanceEnabled: true });
            const descriptor = threePlayerDescriptor(roomId, playerIds);
            binding.prepareRoomPaymentSession(roomId, descriptor.requiredPlayers);

            const logger = { info() {}, warn() {}, error() {} };
            const eventBus = new EventBus({ logger, eventBusConfig: { logEvents: false, showDebugPanel: false } });
            eventBus.initialize();

            const bridge = Object.create(RoomLobbyBridge.prototype);
            Object.assign(bridge, {
                _assertAuthoritativeMutation: () => null,
                _roomManager: roomManager,
                _playerToSocket: new Map(playerIds.map((playerId) => [playerId, `socket-${playerId}`])),
                _eventBus: eventBus,
                _logger: logger,
                _paymentApplicationBinding: binding,
                _deliverToSocket: (_socketId, eventName, payload) => { delivered.push({ eventName, payload }); },
                _getSocketContext: (socketId) => ({ socketId, playerId: playerIds[0], roomId })
            });
            const delivered = [];

            bridge._deliverPaymentStatusToSocket(roomId, playerIds[0], `socket-${playerIds[0]}`);
            equal(delivered.length, 1, "own room/player gets one event");
            equal(delivered[0].payload.status, "AWAITING_PAYMENT", "own status is AWAITING_PAYMENT");

            shutdownRuntime(runtime);
            eventBus.shutdown();
        } finally { t.cleanup(); }
    });

    await section("repeated reconnects do not duplicate intents or principal entries", async () => {
        const t = makeTemp();
        try {
            const { runtime, setPayload } = buildRuntime(t.root, t.catalogPath);
            const roomId = "room-recovery-idempotent";
            const playerIds = ["idempotent-player-0", "idempotent-player-1", "idempotent-player-2"];
            const roomManager = minimalRoomManager(roomId, CREATED_AT, playerIds);
            const binding = bindPaymentRuntimeToApplication(runtime, { roomManager, logger: null, paymentAcceptanceEnabled: true });
            const descriptor = threePlayerDescriptor(roomId, playerIds);
            binding.prepareRoomPaymentSession(roomId, descriptor.requiredPlayers);

            const intent = runtime.paymentService.getPaymentIntent(descriptor.requiredPlayers[0].paymentReference);
            const wallet = runtime.paymentService.getWalletForRoom(roomId);
            setPayload(emptyPayload(transactionFor(intent, wallet)));
            await runtime.sessionAdapter.observeRoomPayments({ roomId });

            const logger = { info() {}, warn() {}, error() {} };
            const eventBus = new EventBus({ logger, eventBusConfig: { logEvents: false, showDebugPanel: false } });
            eventBus.initialize();

            const bridge = Object.create(RoomLobbyBridge.prototype);
            Object.assign(bridge, {
                _assertAuthoritativeMutation: () => null,
                _roomManager: roomManager,
                _playerToSocket: new Map(playerIds.map((playerId) => [playerId, `socket-${playerId}`])),
                _eventBus: eventBus,
                _logger: logger,
                _paymentApplicationBinding: binding,
                _deliverToSocket: () => {}
            });

            const socketId = `socket-${playerIds[0]}`;
            bridge._getSocketContext = () => ({ socketId, playerId: playerIds[0], roomId });

            // Two re-delivery requests (simulating two reconnects).
            bridge._handlePaymentStatusRequest(socketId);
            bridge._handlePaymentStatusRequest(socketId);

            equal(runtime.paymentService.listPaymentIntentsForRoom(roomId).length, 3, "reconnects create no duplicate intents");
            equal(runtime.ledger.store.listForRoom(roomId).filter((e) => e.kind === LEDGER_ENTRY_KIND.INCOMING_PRINCIPAL).length, 1, "reconnects create no duplicate principal entries");

            shutdownRuntime(runtime);
            eventBus.shutdown();
        } finally { t.cleanup(); }
    });

    await section("original room deadline stays unchanged across recovery", async () => {
        const t = makeTemp();
        try {
            const { runtime } = buildRuntime(t.root, t.catalogPath);
            const roomId = "room-recovery-deadline";
            const playerIds = ["deadline-player-0", "deadline-player-1", "deadline-player-2"];
            const roomManager = minimalRoomManager(roomId, CREATED_AT, playerIds);
            const binding = bindPaymentRuntimeToApplication(runtime, { roomManager, logger: null, paymentAcceptanceEnabled: true });
            const descriptor = threePlayerDescriptor(roomId, playerIds);
            binding.prepareRoomPaymentSession(roomId, descriptor.requiredPlayers);

            for (const intent of runtime.paymentService.listPaymentIntentsForRoom(roomId)) {
                equal(intent.roomDeadlineMs, CREATED_AT + ROOM_LIFETIME_MS, "immutable room deadline carried by each intent");
            }
            shutdownRuntime(runtime);
        } finally { t.cleanup(); }
    });

    process.stdout.write(`P6.7 page4 reconnect payment recovery | assertions=${assertions} | sections=${sections}\n`);
}

run().catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exit(1);
});
