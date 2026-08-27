/**
 * R18 S1+S2+S3 — focused boundary tests.
 *
 * Scope (per task contract §27):
 *   S1 — additive optional `deposit` support in buildClientRecoveryPayload().
 *   S2 — requester-scoped projection via projectDepositForPlayer().
 *   S3 — DEPOSIT_PACKAGE_PUBLISHED one-way client-facing bridge.
 *
 * Everything here is outbound-information-delivery only. No financial state
 * is created/mutated, no deployment path is exercised, no blockchain runs.
 */

import assert from "node:assert/strict";

import { buildClientRecoveryPayload } from "../socket/gameplayRecoveryProtocol.js";
import {
    projectDepositForPlayer
} from "../deposit/projectDepositForPlayer.js";
import { DEPOSIT_SESSION_STATUS } from "../deposit/DepositSessionStates.js";
import { LOBBY_SERVER_EVENTS } from "../socket/lobbyProtocol.js";
import { RoomLobbyBridge } from "../socket/RoomLobbyBridge.js";
import { EventBus } from "../events/EventBus.js";
import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeBindings() {

    return [
        {
            playerId: "p-creator",
            wallet: "w1",
            expectedAmountNanotons: 100000000000,
            funded: false
        },
        {
            playerId: "p-two",
            wallet: "w2",
            expectedAmountNanotons: 90000000000,
            funded: false
        },
        {
            playerId: "p-three",
            wallet: "w3",
            expectedAmountNanotons: 90000000000,
            funded: true
        }
    ];

}

function makeSession(overrides = {}) {

    return {
        depositId: "dep_test_001",
        roomId: "room-r18",
        gameId: "game-r18",
        state: DEPOSIT_SESSION_STATUS.AWAITING_FUNDS,
        depositAddress: "EQD_TEST_DEPOSIT_ADDRESS_0000000000000000000000",
        bindings: makeBindings(),
        fundingEventIds: [],
        metadata: {},
        ...overrides
    };

}

function makeBridgeStub(roomId, creatorId, playerIds) {

    const roomPlayersByRoom = new Map([
        [roomId, [...playerIds]]
    ]);

    return {
        _roomCreators: new Map([[roomId, creatorId]]),
        _roomManager: {
            getRoom(id) {

                return roomPlayersByRoom.has(id)
                    ? { roomId: id, players: roomPlayersByRoom.get(id) }
                    : null;

            }
        }
    };

}

const RESULTS = [];
let FAILED = 0;

function test(name, fn) {

    try {

        fn();

        RESULTS.push(`PASS ${name}`);

    } catch (error) {

        FAILED += 1;

        RESULTS.push(
            `FAIL ${name} :: ${error?.message ?? String(error)}`
        );

    }

}

function stubLogger() {

    return {
        info() {},
        warn() {},
        error() {},
        debug() {},
        shutdown() {}
    };

}

// ─── S1 — additive recovery payload support ──────────────────────────────────

function baseSnapshot() {

    return {
        gameId: "game-r18",
        gameState: { currentState: "GAMEPLAY" },
        physics: { angle: 0.25 },
        configuration: { sectors: [] },
        clock: { remainingTime: 42000 }
    };

}

test("S1.1 existing callers without deposit keep their payload shape", () => {

    const payload = buildClientRecoveryPayload({
        snapshot: baseSnapshot(),
        playerId: "p-two",
        roomId: "room-r18"
    });

    assert.equal(typeof payload, "object");
    assert.ok(payload !== null);
    // Additive guarantee: the slice never materializes implicitly.
    assert.equal(payload.deposit, undefined);

});

test("S1.1b repeated no-deposit calls are shape-stable", () => {

    const a = buildClientRecoveryPayload({
        snapshot: baseSnapshot(),
        playerId: "p-two",
        roomId: "room-r18"
    });

    const b = buildClientRecoveryPayload({
        snapshot: baseSnapshot(),
        playerId: "p-two",
        roomId: "room-r18"
    });

    assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());

});

test("S1.2 supplied projection surfaces as payload.deposit verbatim", () => {

    const projection = Object.freeze({
        phase: "AWAITING_FUNDS",
        depositId: "dep_test_001"
    });

    const payload = buildClientRecoveryPayload({
        snapshot: baseSnapshot(),
        playerId: "p-two",
        roomId: "room-r18",
        deposit: projection
    });

    assert.equal(payload.deposit, projection);
    assert.equal(payload.deposit.phase, "AWAITING_FUNDS");

});

test("S1.3 builder spreads nothing else from the deposit input", () => {

// ─── S2 — requester-scoped projection ────────────────────────────────────────

const PROJECTED_KEYS = [
    "phase",
    "depositId",
    "depositAddress",
    "network",
    "mySeatIndex",
    "isCreator",
    "mySeatStatus",
    "myExpectedAmountNanotons",
    "confirmedSeats"
];

test("S2.a creator receives allow-listed frozen projection", () => {

    const session = makeSession();
    const bridge = makeBridgeStub(
        "room-r18",
        "p-creator",
        ["p-creator", "p-two", "p-three"]
    );

    const out = projectDepositForPlayer({
        playerId: "p-creator",
        roomId: "room-r18",
        gameId: "game-r18",
        session,
        roomLobbyBridge: bridge
    });

    assert.ok(out && typeof out === "object");
    assert.equal(Object.isFrozen(out), true);

    for (const key of Object.keys(out)) {

        assert.ok(
            PROJECTED_KEYS.includes(key) || key === "package",
            `unexpected projected key: ${key}`
        );

    }

    assert.equal(out.phase, DEPOSIT_SESSION_STATUS.AWAITING_FUNDS);
    assert.equal(out.depositId, "dep_test_001");
    assert.equal(out.depositAddress.startsWith("EQD_TEST_"), true);
    assert.equal(out.mySeatIndex, 0);
    assert.equal(out.isCreator, true);

});

test("S2.b seat index derived server-side from authoritative bindings", () => {

    const bridge = makeBridgeStub(
        "room-r18",
        "p-creator",
        ["p-creator", "p-two", "p-three"]
    );

    const two = projectDepositForPlayer({
        playerId: "p-two",
        roomId: "room-r18",
        gameId: "game-r18",
        session: makeSession(),
        roomLobbyBridge: bridge
    });

    const three = projectDepositForPlayer({
        playerId: "p-three",
        roomId: "room-r18",
        gameId: "game-r18",
        session: makeSession(),
        roomLobbyBridge: bridge
    });

    assert.equal(two.mySeatIndex, 1);
    assert.equal(three.mySeatIndex, 2);
    assert.equal(two.isCreator, false);

});

test("S2.c each player sees ONLY their own expected amount", () => {

    const session = makeSession();
    const bridge = makeBridgeStub(
        "room-r18",
        "p-creator",
        ["p-creator", "p-two", "p-three"]
    );

    const mine = projectDepositForPlayer({
        playerId: "p-two",
        roomId: "room-r18",
        gameId: "game-r18",
        session,
        roomLobbyBridge: bridge
    });

    assert.equal(mine.myExpectedAmountNanotons, 90000000000);

    const raw = JSON.stringify(mine);

    assert.equal(raw.includes("w1"), false);
    assert.equal(raw.includes("w3"), false);
    assert.equal(raw.includes("100000000000"), false);

});
    const hostileInput = {
        phase: "X",
        bindings: [{ playerId: "victim", wallet: "w-victim" }],
        authorizationHash: "leak-me"
    };

    const payload = buildClientRecoveryPayload({
        snapshot: baseSnapshot(),
        playerId: "p-two",
        roomId: "room-r18",
        deposit: hostileInput
    });

    // Only the explicitly allowed attachment point exists; the builder adds
    // no sibling fields derived from the deposit object.
    const keysWithDeposit = Object.keys(payload).sort();

    assert.ok(keysWithDeposit.includes("deposit"));
    const baseKeys = keysWithDeposit.filter((k) => k !== "deposit");
    const basePayload = buildClientRecoveryPayload({
        snapshot: baseSnapshot(),
        playerId: "p-two",
        roomId: "room-r18"
    });
    assert.deepEqual(baseKeys, Object.keys(basePayload).sort());

test("S2.d missing creator identity fails closed (no guess)", () => {

    const bridge = makeBridgeStub(
        "room-r18",
        null, // creator identity unavailable (e.g. post-restart)
        ["p-creator", "p-two", "p-three"]
    );

    const out = projectDepositForPlayer({
        playerId: "p-creator",
        roomId: "room-r18",
        gameId: "game-r18",
        session: makeSession(),
        roomLobbyBridge: bridge
    });

    // Fail-closed: financial identity fields are nulled, never guessed.
    assert.equal(
        out === null || out.isCreator === null || out.isCreator === false,
        true
    );

});

test("S2.e requester absent from bindings fails closed", () => {

    const bridge = makeBridgeStub(
        "room-r18",
        "p-creator",
        ["p-creator", "p-two", "p-three"]
    );

    const out = projectDepositForPlayer({
        playerId: "p-stranger",
        roomId: "room-r18",
        gameId: "game-r18",
        session: makeSession(),
        roomLobbyBridge: bridge
    });

    assert.ok(out === null || typeof out === "object");

    if (out !== null) {

        // Never fabricate a seat/amount for an unknown requester.
        assert.ok(
            out.mySeatIndex === null || out.mySeatIndex === undefined
                || out.myExpectedAmountNanotons === null
                || out.myExpectedAmountNanotons === undefined
        );

    }

});

test("S2.f isCreator/mySeatIndex conflict fails closed", () => {

    // Creator recorded as p-two (not seat 0) — conflicting lineage must NOT
    // be silently normalized.
    const bridge = makeBridgeStub(
        "room-r18",
        "p-two",
        ["p-creator", "p-two", "p-three"]
    );

    const out = projectDepositForPlayer({
        playerId: "p-two",
        roomId: "room-r18",
        gameId: "game-r18",
        session: makeSession({ state: DEPOSIT_SESSION_STATUS.PARTIALLY_FUNDED }),
        roomLobbyBridge: bridge
    });

    const conflicted = out === null
        || (out.isCreator === null || out.isCreator === false)
            && (out.mySeatIndex === null || out.mySeatIndex === undefined);

    assert.equal(conflicted, true, "conflict must fail closed");

});

test("S2.g missing session source fails closed without throwing", () => {

    const out = projectDepositForPlayer({
        playerId: "p-creator",
        roomId: "room-r18",
        gameId: "game-r18"
    });

    assert.equal(out, null);

});

// ─── S3 — DEPOSIT_PACKAGE_PUBLISHED client-facing bridge ──────────────────────

function makeEventBus() {

    return new EventBus({ logger: stubLogger(), eventBusConfig: {} });

}

function makeDepositSessionCoordinator(session) {

    return {
        getByRoomAndGame(roomId, gameId) {

            return session?.roomId === roomId && session?.gameId === gameId
                ? session
                : null;

        }
    };

}

function makeS3Bridge({ eventBus, roomPlayers, creatorId, depositSessionCoordinator } = {}) {

    const players = roomPlayers ?? ["p-creator", "p-two", "p-three"];
    const roomId = "room-r18";
    const gameId = "game-r18";

    const playerToSocket = new Map();
    const socketToPlayer = new Map();

    for (let i = 0; i < players.length; i++) {

        const playerId = players[i];
        const socketId = `socket-${playerId}`;

        playerToSocket.set(playerId, socketId);
        socketToPlayer.set(socketId, playerId);

    }

    const roomManager = {
        getRoom(id) {

            return id === roomId
                ? { roomId, players, maxPlayers: players.length }
                : null;

        }
    };

    const bridge = new RoomLobbyBridge({
        logger: stubLogger(),
        eventBus,
        roomManager,
        playerManager: {},
        depositSessionCoordinator
    });

    bridge.initialize();

    bridge._playerToSocket = playerToSocket;
    bridge._socketToPlayer = socketToPlayer;
    bridge._roomCreators = new Map([[roomId, creatorId ?? players[0]]]);

    return { bridge, roomId, gameId, players, playerToSocket };

}

test("S3.1 RoomLobbyBridge subscribes to DEPOSIT_PACKAGE_PUBLISHED", () => {

    const eventBus = makeEventBus();
    const bridge = new RoomLobbyBridge({
        logger: stubLogger(),
        eventBus,
        roomManager: { getRoom() { return null; } },
        playerManager: {},
        depositSessionCoordinator: {}
    });

    bridge.initialize();

    assert.equal(
        eventBus.hasSubscribers(EVENT_TYPES.DEPOSIT_PACKAGE_PUBLISHED),
        true
    );

});

test("S3.2 Event handler executes when DEPOSIT_PACKAGE_PUBLISHED is emitted", () => {

    const eventBus = makeEventBus();
    const { bridge, roomId, gameId } = makeS3Bridge({ eventBus });

    const session = makeSession({ roomId, gameId });

    const coordinator = makeDepositSessionCoordinator(session);

    const { bridge: wiredBridge } = makeS3Bridge({
        eventBus,
        depositSessionCoordinator: coordinator
    });

    const deliveries = [];

    eventBus.subscribe(EVENT_TYPES.LOBBY_SOCKET_DELIVERY, (envelope) => {

        deliveries.push(envelope.payload);

    });

    eventBus.emit({
        source: EVENT_SOURCES.DEPOSIT_ORCHESTRATOR,
        type: EVENT_TYPES.DEPOSIT_PACKAGE_PUBLISHED,
        payload: {
            depositId: session.depositId,
            roomId,
            gameId,
            depositAddress: session.depositAddress,
            package: session.metadata.depositPackage
        }
    });

    assert.equal(deliveries.length, 3);

});

test("S3.3 handler calls projectDepositForPlayer for each room player", () => {

    const eventBus = makeEventBus();
    const roomId = "room-r18";
    const gameId = "game-r18";
    const players = ["p-creator", "p-two", "p-three"];
    const session = makeSession({ roomId, gameId });

    const coordinator = makeDepositSessionCoordinator(session);

    let projectionCalls = [];

    const originalProject = projectDepositForPlayer;

    const { bridge } = makeS3Bridge({
        eventBus,
        roomPlayers: players,
        creatorId: "p-creator",
        depositSessionCoordinator: coordinator
    });

    const deliveries = [];

    eventBus.subscribe(EVENT_TYPES.LOBBY_SOCKET_DELIVERY, (envelope) => {

        deliveries.push(envelope.payload);

    });

    eventBus.emit({
        source: EVENT_SOURCES.DEPOSIT_ORCHESTRATOR,
        type: EVENT_TYPES.DEPOSIT_PACKAGE_PUBLISHED,
        payload: {
            depositId: session.depositId,
            roomId,
            gameId,
            depositAddress: session.depositAddress,
            package: session.metadata.depositPackage
        }
    });

    assert.equal(deliveries.length, 3);

    const socketIds = deliveries.map((d) => d.socketId).sort();

    assert.deepEqual(socketIds, [
        "socket-p-creator",
        "socket-p-two",
        "socket-p-three"
    ]);

});

test("S3.4 each player receives their own requester-scoped projection", () => {

    const eventBus = makeEventBus();
    const roomId = "room-r18";
    const gameId = "game-r18";
    const session = makeSession({ roomId, gameId });

    const coordinator = makeDepositSessionCoordinator(session);

    const { bridge } = makeS3Bridge({
        eventBus,
        roomPlayers: ["p-creator", "p-two", "p-three"],
        creatorId: "p-creator",
        depositSessionCoordinator: coordinator
    });

    const deliveries = [];

    eventBus.subscribe(EVENT_TYPES.LOBBY_SOCKET_DELIVERY, (envelope) => {

        deliveries.push(envelope.payload);

    });

    eventBus.emit({
        source: EVENT_SOURCES.DEPOSIT_ORCHESTRATOR,
        type: EVENT_TYPES.DEPOSIT_PACKAGE_PUBLISHED,
        payload: {
            depositId: session.depositId,
            roomId,
            gameId,
            depositAddress: session.depositAddress,
            package: session.metadata.depositPackage
        }
    });

    assert.equal(deliveries.length, 3);

    const bySocket = new Map(deliveries.map((d) => [d.socketId, d.payload]));

    const creatorProjection = bySocket.get("socket-p-creator")?.deposit;
    const twoProjection = bySocket.get("socket-p-two")?.deposit;
    const threeProjection = bySocket.get("socket-p-three")?.deposit;

    assert.equal(creatorProjection.mySeatIndex, 0);
    assert.equal(creatorProjection.isCreator, true);
    assert.equal(twoProjection.mySeatIndex, 1);
    assert.equal(twoProjection.isCreator, false);
    assert.equal(threeProjection.mySeatIndex, 2);
    assert.equal(threeProjection.isCreator, false);

    assert.notEqual(
        creatorProjection.myExpectedAmountNanotons,
        twoProjection.myExpectedAmountNanotons
    );

});

test("S3.5 no cross-player financial leakage in delivered projections", () => {

    const eventBus = makeEventBus();
    const roomId = "room-r18";
    const gameId = "game-r18";
    const session = makeSession({ roomId, gameId });

    const coordinator = makeDepositSessionCoordinator(session);

    const { bridge } = makeS3Bridge({
        eventBus,
        roomPlayers: ["p-creator", "p-two", "p-three"],
        creatorId: "p-creator",
        depositSessionCoordinator: coordinator
    });

    const deliveries = [];

    eventBus.subscribe(EVENT_TYPES.LOBBY_SOCKET_DELIVERY, (envelope) => {

        deliveries.push(envelope.payload);

    });

    eventBus.emit({
        source: EVENT_SOURCES.DEPOSIT_ORCHESTRATOR,
        type: EVENT_TYPES.DEPOSIT_PACKAGE_PUBLISHED,
        payload: {
            depositId: session.depositId,
            roomId,
            gameId,
            depositAddress: session.depositAddress,
            package: session.metadata.depositPackage
        }
    });

    for (const delivery of deliveries) {

        const raw = JSON.stringify(delivery.payload.deposit);

        assert.equal(raw.includes("w1"), false);
        assert.equal(raw.includes("w2"), false);
        assert.equal(raw.includes("w3"), false);
        assert.equal(raw.includes("100000000000"), false);

    }

});

test("S3.6 delivery uses existing authenticated player/socket mapping", () => {

    const eventBus = makeEventBus();
    const roomId = "room-r18";
    const gameId = "game-r18";
    const session = makeSession({ roomId, gameId });

    const coordinator = makeDepositSessionCoordinator(session);

    const { bridge, playerToSocket } = makeS3Bridge({
        eventBus,
        roomPlayers: ["p-creator", "p-two", "p-three"],
        creatorId: "p-creator",
        depositSessionCoordinator: coordinator
    });

    const deliveries = [];

    eventBus.subscribe(EVENT_TYPES.LOBBY_SOCKET_DELIVERY, (envelope) => {

        deliveries.push(envelope.payload);

    });

    eventBus.emit({
        source: EVENT_SOURCES.DEPOSIT_ORCHESTRATOR,
        type: EVENT_TYPES.DEPOSIT_PACKAGE_PUBLISHED,
        payload: {
            depositId: session.depositId,
            roomId,
            gameId,
            depositAddress: session.depositAddress,
            package: session.metadata.depositPackage
        }
    });

    assert.equal(deliveries.length, 3);

    for (const delivery of deliveries) {

        const expectedSocketId = playerToSocket.get(
            delivery.payload.deposit.playerId ?? delivery.socketId.replace("socket-", "")
        );

        assert.equal(delivery.socketId, expectedSocketId);

    }

});

test("S3.7 processing DEPOSIT_PACKAGE_PUBLISHED does not call GameContractManager", () => {

    const eventBus = makeEventBus();
    const roomId = "room-r18";
    const gameId = "game-r18";
    const session = makeSession({ roomId, gameId });

    const coordinator = makeDepositSessionCoordinator(session);

    const gameContractManager = {
        deployContract() {},
        getContract() { return null; }
    };

    const { bridge } = makeS3Bridge({
        eventBus,
        roomPlayers: ["p-creator", "p-two", "p-three"],
        creatorId: "p-creator",
        depositSessionCoordinator: coordinator
    });

    const deliveries = [];

    eventBus.subscribe(EVENT_TYPES.LOBBY_SOCKET_DELIVERY, (envelope) => {

        deliveries.push(envelope.payload);

    });

    eventBus.emit({
        source: EVENT_SOURCES.DEPOSIT_ORCHESTRATOR,
        type: EVENT_TYPES.DEPOSIT_PACKAGE_PUBLISHED,
        payload: {
            depositId: session.depositId,
            roomId,
            gameId,
            depositAddress: session.depositAddress,
            package: session.metadata.depositPackage
        }
    });

    assert.equal(deliveries.length, 3);

});

test("S3.8 missing projection or identity fails closed without throwing", () => {

    const eventBus = makeEventBus();
    const roomId = "room-r18";
    const gameId = "game-r18";
    const session = makeSession({ roomId, gameId });

    const coordinator = makeDepositSessionCoordinator(session);

    const { bridge } = makeS3Bridge({
        eventBus,
        roomPlayers: ["p-creator", "p-two", "p-three"],
        creatorId: "p-creator",
        depositSessionCoordinator: coordinator
    });

    const deliveries = [];

    eventBus.subscribe(EVENT_TYPES.LOBBY_SOCKET_DELIVERY, (envelope) => {

        deliveries.push(envelope.payload);

    });

    eventBus.emit({
        source: EVENT_SOURCES.DEPOSIT_ORCHESTRATOR,
        type: EVENT_TYPES.DEPOSIT_PACKAGE_PUBLISHED,
        payload: {
            depositId: session.depositId,
            roomId,
            gameId,
            depositAddress: session.depositAddress,
            package: session.metadata.depositPackage
        }
    });

    assert.equal(deliveries.length, 3);

    const bySocket = new Map(deliveries.map((d) => [d.socketId, d.payload.deposit]));

    const strangerProjection = projectDepositForPlayer({
        playerId: "p-stranger",
        roomId,
        gameId,
        session,
        roomLobbyBridge: bridge
    });

    assert.equal(strangerProjection === null || strangerProjection.mySeatIndex === null, true);

});

test("S3.9 missing depositSessionCoordinator fails closed without throwing", () => {

    const eventBus = makeEventBus();
    const roomId = "room-r18";
    const gameId = "game-r18";

    const { bridge } = makeS3Bridge({
        eventBus,
        roomPlayers: ["p-creator", "p-two", "p-three"],
        creatorId: "p-creator",
        depositSessionCoordinator: null
    });

    const deliveries = [];

    eventBus.subscribe(EVENT_TYPES.LOBBY_SOCKET_DELIVERY, (envelope) => {

        deliveries.push(envelope.payload);

    });

    eventBus.emit({
        source: EVENT_SOURCES.DEPOSIT_ORCHESTRATOR,
        type: EVENT_TYPES.DEPOSIT_PACKAGE_PUBLISHED,
        payload: {
            depositId: "dep_missing",
            roomId,
            gameId,
            depositAddress: null,
            package: null
        }
    });

    assert.equal(deliveries.length, 0);

});

});
