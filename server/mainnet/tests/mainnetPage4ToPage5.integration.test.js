import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EventBus } from "../../events/EventBus.js";
import { EVENT_SOURCES } from "../../events/EventSources.js";
import { EVENT_TYPES } from "../../events/EventTypes.js";
import { GameStartAuthorization, GAME_START_PHASE } from "../../gameplay/GameStartAuthorization.js";
import { loadMainnetRuntimeConfig } from "../config/MainnetRuntimeConfig.js";
import { MainnetPaymentRuntime } from "../payment/MainnetPaymentRuntime.js";
import { RoomLobbyBridge } from "../../socket/RoomLobbyBridge.js";
import { LOBBY_SERVER_EVENTS } from "../../socket/lobbyProtocol.js";
import { ActiveRoomObservationBudget } from "../../payment/runtime/ActiveRoomObservationBudget.js";

const ROOM_ID = "mainnet-page4-page5";
const GAME_ID = "mainnet-game-page4-page5";
const PLAYERS = ["p1", "p2", "p3"];
const log = { info() {}, warn() {}, error() {}, decisionTrace() {} };

function createHarness(t, { liveOperationsEnabled = true } = {}) {
    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-mainnet-page4-page5-"));
    t.after(() => rmSync(dataDir, { recursive: true, force: true }));
    const walletCatalog = Array.from({ length: 64 }, (_, index) => ({
        walletId: `mn-${index + 1}`,
        roomNumber: index + 1,
        address: `0:${String(index + 100).padStart(64, "0")}`,
        network: "mainnet"
    }));
    const config = loadMainnetRuntimeConfig({
        TON_NETWORK: "mainnet",
        MAINNET_TONCENTER_API_KEY: "offline-only",
        MAINNET_ROOM_WALLETS_JSON: JSON.stringify(walletCatalog),
        MAINNET_ROOM_WALLET_DATA_DIR: dataDir
    });
    let runtime = new MainnetPaymentRuntime({ config });
    runtime.liveOperationsEnabled = liveOperationsEnabled;
    const reservations = runtime.walletPool;
    const wallet = { walletId: "mn-1", network: "mainnet", globalId: -239,
        address: `0:${String(200).padStart(64, "0")}` };
    runtime.incomingPayments.createRoomPaymentIntents({
        roomId: ROOM_ID,
        wallet,
        createdAt: 1_000,
        expiresAt: 100_000,
        players: PLAYERS.map((playerId, index) => ({
            playerId,
            expectedSender: `0:${String(index + 1).padStart(64, "0")}`,
            amountAtomic: String((index + 1) * 1_000_000_000),
            paymentReference: `mainnet_${playerId}`
        }))
    });
    const room = { roomId: ROOM_ID, maxPlayers: 3, players: [...PLAYERS], status: "ACTIVE" };
    const roomManager = { getRoom: id => id === ROOM_ID ? room : null };
    const identities = new Map(PLAYERS.map(playerId => [playerId, { playerId, nickname: playerId }]));
    const playerManager = {
        getIdentity: playerId => identities.get(playerId) ?? null,
        hasPlayer: playerId => identities.has(playerId),
        getRuntime: playerId => ({ roomId: ROOM_ID, gameId: GAME_ID }),
        setConnectionState() {}
    };
    const eventBus = new EventBus({ logger: log,
        eventBusConfig: { logEvents: false, showDebugPanel: false } });
    eventBus.initialize();
    const authorization = new GameStartAuthorization({
        logger: log,
        eventBus,
        roomManager,
        playerManager,
        gameManager: {
            getPendingGameplayGameId: id => id === ROOM_ID ? GAME_ID : null,
            getGame: id => id === GAME_ID ? { id } : null
        },
        configurationEngine: {
            getConfiguration: id => id === GAME_ID ? { traceSeed: "offline-seed" } : null,
            validateConfiguration() {}
        },
        recoveryEngine: { getRecoverySnapshot: () => null },
        paymentGate: runtime.gameStartPaymentGate
    });
    const emitted = [];
    const deliveries = [];
    const bridge = Object.create(RoomLobbyBridge.prototype);
    Object.assign(bridge, {
        _getSocketContext: socketId => {
            const playerId = PLAYERS.find(id => socketId === `socket-${id}`);
            return playerId ? { socketId, playerId, roomId: ROOM_ID } : null;
        },
        _deliverPaymentStatusToSocket() {},
        _roomManager: roomManager,
        _playerManager: playerManager,
        _verifyBarrierCompletedByRoom: new Set([ROOM_ID]),
        _paymentApplicationBinding: {
            runtime,
            walletPool: { getReservationForRoom: id => id === ROOM_ID
                ? { walletId: "mn-1", address: wallet.address } : null }
        },
        _playerToSocket: new Map(PLAYERS.map(id => [id, `socket-${id}`])),
        _eventBus: eventBus,
        _logger: log,
        _roomPaymentObservationRequestedPlayers: new Map(),
        _roomPaymentObservationRequestedAt: new Map([[ROOM_ID, Date.now() - 5_000]]),
        _roomPaymentSubmissionAcknowledgedPlayers: new Map(),
        _paymentNoSignalLogged: new Set(),
        _roomObservationBudget: new ActiveRoomObservationBudget(),
        _roomPaymentChecks: new Map(),
        _deliverToRoom(roomId, event, payload) { deliveries.push({ roomId, event, payload }); },
        _deliverToSocket(socketId, event, payload) { deliveries.push({ socketId, event, payload }); },
        _deliverSecretMatrixStatus() {},
        _buildPlayerList: activeRoom => activeRoom.players.map(playerId => ({ playerId })),
        _clearRecoveryOwnershipForPlayer() {},
        _requestForceDisconnect() {},
        _attachSocketToRoom() {},
        _markPendingSocket() {},
        _commitSocketAuthority({ playerId, roomId, newSocketId }) {
            bridge._socketToPlayer.set(newSocketId, playerId);
            bridge._playerToSocket.set(playerId, newSocketId);
            return { ok: true, oldSocketId: null };
        },
        _isActiveGameplayProtected: () => false,
        _buildRoomRecoverySync: () => ({ stage: "GAMEPLAY" }),
        _page4PaymentAcceptanceEnabled: () => false
    });
    bridge._socketToPlayer = new Map();
    bridge._recoveryOwnershipBySocket = new Map();
    bridge._recoveryOwnershipByPlayer = new Map();
    bridge._obsoleteSockets = new Map();
    bridge._startedRooms = new Set([ROOM_ID]);
    bridge._setupSessionLifecycle = { isRecoverable: () => false };
    bridge._resultSessionLifecycle = { isActive: () => false };
    bridge._profilesRevealedByRoom = new Set();
    bridge._secretMatrixAcceptedByRoom = new Set();
    bridge._verifyConfirmedByRoom = new Map();
    bridge._continueToVerifyByRoom = new Map();
    bridge._noFriendsOptionsReadyByRoom = new Map();
    bridge._roomNetworkByRoom = new Map([[ROOM_ID, "mainnet"]]);
    bridge._gameStartAuthorization = authorization;

    for (const type of [EVENT_TYPES.VERIFY_BARRIER_COMPLETED,
        EVENT_TYPES.GAME_START_AUTHORIZED, EVENT_TYPES.GAME_INITIALIZING,
        EVENT_TYPES.GAME_START_BOOTSTRAP_READY]) {
        eventBus.subscribe(type, envelope => emitted.push(envelope));
    }
    authorization.initialize();
    eventBus.subscribe(EVENT_TYPES.GAME_START_AUTHORIZED,
        envelope => bridge._deliverGameStartAuthorized(envelope.payload));
    eventBus.subscribe(EVENT_TYPES.GAME_INITIALIZING,
        envelope => bridge._deliverGameInitializing(envelope.payload));
    eventBus.subscribe(EVENT_TYPES.GAME_START_BOOTSTRAP_READY,
        envelope => bridge._handleGameStartBootstrapReady(envelope.payload));

    return {
        bridge, authorization, config, dataDir, deliveries, emitted,
        get runtime() { return runtime; },
        restartRuntime() {
            runtime = new MainnetPaymentRuntime({ config });
            runtime.liveOperationsEnabled = liveOperationsEnabled;
            bridge._paymentApplicationBinding.runtime = runtime;
            authorization.configurePaymentGate(runtime.gameStartPaymentGate);
            return runtime;
        },
        shutdown() { authorization.shutdown(); eventBus.shutdown(); }
    };
}

function confirmIntent(runtime, intent) {
    const observation = {
        network: "mainnet", globalId: -239, roomId: ROOM_ID,
        transactionId: `tx-${intent.playerId}`,
        payloadFingerprint: createHash("sha256").update(intent.playerId).digest("hex"),
        sourceAddress: intent.expectedSender,
        destinationAddress: intent.destinationWalletAddress,
        amountAtomic: intent.amountAtomic, asset: "TON",
        transactionTime: 50_000, observedAt: 50_001
    };
    runtime.incomingLedger.recordTransfer({
        observation,
        receipt: {
            network: "mainnet", globalId: -239, roomId: ROOM_ID,
            transactionId: observation.transactionId, status: "CONFIRMED", reason: null,
            paymentReference: intent.paymentReference, playerId: intent.playerId,
            amountAtomic: intent.amountAtomic, sourceAddress: intent.expectedSender,
            destinationAddress: intent.destinationWalletAddress,
            transactionTime: observation.transactionTime, updatedAt: observation.observedAt,
            asset: "TON"
        },
        settleReference: intent.paymentReference
    });
}

async function requestPage4Status(harness, request = {}) {
    harness.bridge._roomObservationRequestedAt?.set?.(ROOM_ID, Date.now() - 5_000);
    harness.bridge._roomPaymentObservationRequestedAt.set(ROOM_ID, Date.now() - 5_000);
    harness.bridge._roomObservationBudget = new ActiveRoomObservationBudget();
    harness.bridge._paymentApplicationBinding.runtime.incomingPayments.observeRoom = async () => ({
        status: "OBSERVED"
    });
    harness.bridge._handlePaymentStatusRequest("socket-p1", {
        observationRequested: true,
        ...request
    });
    const pending = harness.bridge._roomPaymentChecks.get(ROOM_ID);
    assert.ok(pending, "authenticated Page4 request starts the mocked read-only observer");
    await pending;
}

test("Mainnet Page4 requires ledger 3/3 and opens Page5 once through shared server lifecycle", async t => {
    const h = createHarness(t);
    try {
        for (const count of [0, 1, 2]) {
            for (const intent of h.runtime.incomingLedger.listRoomIntents(ROOM_ID).slice(
                h.runtime.incomingLedger.getRoomPaymentStatus(ROOM_ID).confirmedCount, count
            )) confirmIntent(h.runtime, intent);
            await requestPage4Status(h, {
                confirmedCount: 3, paid: true, paymentStatus: "3/3", playerId: "spoofed-player"
            });
            assert.equal(h.authorization.getLifecycle(ROOM_ID), null,
                `${count}/3 server-confirmed receipts must not start gameplay`);
            assert.equal(h.emitted.some(event => event.type === EVENT_TYPES.VERIFY_BARRIER_COMPLETED), false,
                "client payment claims cannot trigger the server barrier");
        }

        for (const intent of h.runtime.incomingLedger.listRoomIntents(ROOM_ID)) {
            if (intent.state !== "SETTLED") confirmIntent(h.runtime, intent);
        }
        await requestPage4Status(h, { confirmedCount: 0, paid: false });

        const startTypes = h.emitted.map(event => event.type).filter(type => [
            EVENT_TYPES.VERIFY_BARRIER_COMPLETED,
            EVENT_TYPES.GAME_START_AUTHORIZED,
            EVENT_TYPES.GAME_INITIALIZING,
            EVENT_TYPES.GAME_START_BOOTSTRAP_READY
        ].includes(type));
        assert.deepEqual(startTypes, [
            EVENT_TYPES.VERIFY_BARRIER_COMPLETED,
            EVENT_TYPES.GAME_START_AUTHORIZED,
            EVENT_TYPES.GAME_INITIALIZING,
            EVENT_TYPES.GAME_START_BOOTSTRAP_READY
        ]);
        assert.equal(h.authorization.getLifecycle(ROOM_ID).phase, GAME_START_PHASE.OPENED);
        assert.equal(h.deliveries.filter(delivery => delivery.event === LOBBY_SERVER_EVENTS.OPEN_PAGE5).length, 1);

        await requestPage4Status(h, { paymentStatus: "0/3", paid: false });
        const duplicateVerify = {
            source: EVENT_SOURCES.ROOM_LOBBY_BRIDGE,
            type: EVENT_TYPES.VERIFY_BARRIER_COMPLETED,
            payload: { roomId: ROOM_ID, paymentAcceptanceEnabled: true }
        };
        h.runtime.gameStartPaymentGate.getGameStartGateStatus(ROOM_ID, PLAYERS);
        h.bridge._eventBus.emit(duplicateVerify);
        assert.equal(h.emitted.filter(event => event.type === EVENT_TYPES.GAME_START_AUTHORIZED).length, 1,
            "duplicate Page4 requests/barrier events do not bootstrap twice");
        assert.equal(h.deliveries.filter(delivery => delivery.event === LOBBY_SERVER_EVENTS.OPEN_PAGE5).length, 1);
        assert.equal(h.runtime.incomingLedger.listReceipts(ROOM_ID).length, 3,
            "repeated status requests do not duplicate ledger receipts");

        const restarted = h.restartRuntime();
        assert.equal(restarted.gameStartPaymentGate.getGameStartGateStatus(ROOM_ID, PLAYERS).status, "3/3",
            "confirmed Mainnet payments survive a payment-runtime restart");
        assert.equal(restarted.incomingLedger.listReceipts(ROOM_ID).length, 3);

        h.bridge._recoveryOwnershipBySocket.set("socket-p1-reconnected", {
            playerId: "p1", roomId: ROOM_ID
        });
        const reconnect = h.bridge.reconnectSession("socket-p1-reconnected", { roomId: ROOM_ID });
        assert.equal(reconnect.ok, true);
        assert.equal(reconnect.gameStartPhase, GAME_START_PHASE.OPENED);
        assert.equal(h.deliveries.some(delivery => delivery.socketId === "socket-p1-reconnected"
            && delivery.event === LOBBY_SERVER_EVENTS.OPEN_PAGE5), true);
        assert.equal(h.deliveries.some(delivery => delivery.socketId === "socket-p1-reconnected"
            && delivery.event === LOBBY_SERVER_EVENTS.PAYMENT_STAGE_READY), false,
        "reconnect after Page5 restores gameplay and does not route the player to Page4");
    } finally {
        h.shutdown();
    }
});

test("Mainnet liveOperationsEnabled=false keeps Page5 closed even with 3/3 and client claims", async t => {
    const h = createHarness(t, { liveOperationsEnabled: false });
    try {
        for (const intent of h.runtime.incomingLedger.listRoomIntents(ROOM_ID)) confirmIntent(h.runtime, intent);
        await requestPage4Status(h, { confirmedCount: 3, paid: true, paymentStatus: "3/3" });
        assert.equal(h.runtime.gameStartPaymentGate.getGameStartGateStatus(ROOM_ID, PLAYERS).eligible, true,
            "test fixture proves the ledger is 3/3 while operations remain disabled");
        assert.equal(h.authorization.getLifecycle(ROOM_ID), null);
        assert.equal(h.emitted.some(event => event.type === EVENT_TYPES.VERIFY_BARRIER_COMPLETED), false);
        assert.equal(h.deliveries.some(delivery => delivery.event === LOBBY_SERVER_EVENTS.OPEN_PAGE5), false);
    } finally {
        h.shutdown();
    }
});
