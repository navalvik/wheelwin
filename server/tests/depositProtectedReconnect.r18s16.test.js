/**
 * R18-S16 — Protected same-id reconnect must rehydrate live Deposit state.
 *
 * Keah forensic: Lena's GameplayContextResolver stayed bound=true, so
 * reconnectSession was skipped and Page4 kept the initial 0/3 projection.
 *
 * No TON. No GameEscrow. No Telegram credential rebind.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { CONNECTION_STATE } from "../models/ConnectionState.js";
import { PlayerManager } from "../managers/PlayerManager.js";
import { RoomManager } from "../managers/RoomManager.js";
import { LoggerService } from "../services/LoggerService.js";
import { GameplayContextResolver } from "../socket/GameplayContextResolver.js";
import { RoomLobbyBridge } from "../socket/RoomLobbyBridge.js";
import { SocketGateway } from "../socket/SocketGateway.js";
import { SetupSessionLifecycle } from "../gameplay/SetupSessionLifecycle.js";
import { LOBBY_SERVER_EVENTS } from "../socket/lobbyProtocol.js";
import { DEPOSIT_SESSION_STATUS } from "../deposit/DepositSessionStates.js";
import { RECOVERY_SOCKET_MESSAGE_TYPES } from "../socket/gameplayRecoveryProtocol.js";
import { loadRoomConfig } from "../config/rooms.js";

const GAME_ID = "game_3f076a0f-76b2-402e-b402-fcc062b8d421";
const DEPOSIT_ADDRESS = "EQDS6oOJ0q-nM7pZnAwDF6PgUQPKc_stNX1WLp0qII1yTUdc";
const DEPLOY_VALUE_NANOTONS = "10000000";
const CREATION_FEE_PER_SEAT = "1000000";
const EXPECTED_STAKE = 10000000;
const FUNDSEAT_AMOUNT = 11000000;
const BOB_SOCKET_ID = "sock_bob_r18s16_iso";
const LENA_SOCKET_ID = "c0QikAAlyHNBuzbvAAFc";
const OLGA_SOCKET_ID = "sock_olga_r18s16_iso";

function stubCoordinator(session) {

    return {
        getByRoomAndGame(roomId, gameId) {

            return session.roomId === roomId && session.gameId === gameId
                ? session
                : null;

        }
    };

}

function makeLiveSession({ roomId, playerIds, bobFunded, lenaFunded }) {

    const [olgaId, bobId, lenaId] = playerIds;

    return {
        depositId: "dep_2a54a5e6-6127-43ac-934f-9afc8853a9d5",
        roomId,
        gameId: GAME_ID,
        state: DEPOSIT_SESSION_STATUS.PARTIALLY_FUNDED,
        depositAddress: DEPOSIT_ADDRESS,
        bindings: [
            {
                playerId: olgaId,
                wallet: "EQC9qwKAy72kX1oPtryX-g5y44B2mYZEB2HVdJAeJprla_Le",
                expectedAmount: FUNDSEAT_AMOUNT,
                receivedAmount: 0,
                funded: false
            },
            {
                playerId: bobId,
                wallet: "EQAtggW7l5wfQcPyy38Y7mVuXnh0wRHcpFKPIdtCbcRHb8wM",
                expectedAmount: FUNDSEAT_AMOUNT,
                receivedAmount: bobFunded ? FUNDSEAT_AMOUNT : 0,
                funded: bobFunded === true
            },
            {
                playerId: lenaId,
                wallet: "EQDeWBnzASv1uz8OUCqjoGb_yrW_TVLc84S5szqFfjkHyCzp",
                expectedAmount: FUNDSEAT_AMOUNT,
                receivedAmount: lenaFunded ? FUNDSEAT_AMOUNT : 0,
                funded: lenaFunded === true
            }
        ],
        metadata: {
            network: "testnet",
            creationFeePerSeat: Number(CREATION_FEE_PER_SEAT),
            depositPackage: {
                network: "testnet",
                deployValueNanotons: DEPLOY_VALUE_NANOTONS,
                stateInit: {
                    codeBoc: "te6ccgECCQAj/RASTl3GZs",
                    dataBoc: "abc123data"
                },
                bindings: [
                    {
                        playerId: olgaId,
                        funded: false,
                        receivedAmount: 0,
                        expectedAmount: FUNDSEAT_AMOUNT,
                        expectedStake: EXPECTED_STAKE
                    },
                    {
                        playerId: bobId,
                        funded: false,
                        receivedAmount: 0,
                        expectedAmount: FUNDSEAT_AMOUNT,
                        expectedStake: EXPECTED_STAKE
                    },
                    {
                        playerId: lenaId,
                        funded: false,
                        receivedAmount: 0,
                        expectedAmount: FUNDSEAT_AMOUNT,
                        expectedStake: EXPECTED_STAKE
                    }
                ]
            },
            activationVerification: {
                status: "VERIFIED",
                depositAddress: DEPOSIT_ADDRESS
            }
        }
    };

}

function buildStack() {

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
        roomConfig: { maxPlayers: 3 }
    });

    roomManager.initialize();

    const gameplayContextResolver = new GameplayContextResolver({
        logger,
        playerManager,
        roomManager
    });

    const setupSessionLifecycle = new SetupSessionLifecycle({
        logger,
        eventBus,
        roomManager,
        roomConfig: { setupDurationMs: 8 * 60 * 1000 }
    });

    setupSessionLifecycle.initialize();

    roomManager.attachSetupSessionLifecycle(setupSessionLifecycle);

    const roomLobbyBridge = new RoomLobbyBridge({
        logger,
        eventBus,
        roomManager,
        playerManager,
        gameplayContextResolver,
        setupSessionLifecycle
    });

    roomLobbyBridge.initialize();

    const deliveries = [];

    eventBus.subscribe(EVENT_TYPES.LOBBY_SOCKET_DELIVERY, (envelope) => {

        deliveries.push(envelope.payload);

    });

    return {
        logger,
        eventBus,
        playerManager,
        roomManager,
        setupSessionLifecycle,
        roomLobbyBridge,
        gameplayContextResolver,
        deliveries,
        shutdown() {

            roomLobbyBridge.shutdown();
            setupSessionLifecycle.shutdown();
            roomManager.shutdown();
            playerManager.shutdown();
            eventBus.shutdown();
            logger.shutdown();

        }
    };

}

function arrangeKeahRoom(stack) {

    const room = stack.roomManager.createRoom();

    const playerIds = [];

    const sockets = ["g8QukQQQumPjpDYmAAFq", "hpP_g3lm_iTVeuyaAAFt", LENA_SOCKET_ID];

    for (const [index, nickname] of ["Olga", "Bob", "Lena"].entries()) {

        const player = stack.playerManager.createPlayer({ nickname });

        const playerId = player.identity.playerId;

        playerIds.push(playerId);

        stack.roomManager.addPlayer(room.roomId, playerId);

        stack.playerManager.updateRuntime(playerId, {
            roomId: room.roomId,
            gameId: GAME_ID
        });

        stack.roomLobbyBridge._registerSocketPlayer(sockets[index], playerId);

        stack.roomLobbyBridge._attachSocketToRoom(sockets[index], room.roomId);

        stack.playerManager.setConnectionState(playerId, CONNECTION_STATE.CONNECTED);

    }

    stack.roomLobbyBridge._roomCreators.set(room.roomId, playerIds[0]);

    stack.roomLobbyBridge._startedRooms.add(room.roomId);

    stack.gameplayContextResolver.activateRoomGame(room.roomId, GAME_ID);

    const session = makeLiveSession({
        roomId: room.roomId,
        playerIds,
        bobFunded: false,
        lenaFunded: false
    });

    stack.roomLobbyBridge._depositSessionCoordinator = stubCoordinator(session);

    return {
        room,
        playerIds,
        lenaId: playerIds[2],
        session
    };

}

function fundBobAndLena(session) {

    session.bindings[1].funded = true;
    session.bindings[1].receivedAmount = FUNDSEAT_AMOUNT;
    session.bindings[2].funded = true;
    session.bindings[2].receivedAmount = FUNDSEAT_AMOUNT;
    session.state = DEPOSIT_SESSION_STATUS.PARTIALLY_FUNDED;

}

function depositDeliveriesSince(stack, before) {

    return stack.deliveries
        .slice(before)
        .filter((delivery) =>
            delivery.event === LOBBY_SERVER_EVENTS.DEPOSIT_PACKAGE_PUBLISHED
            && delivery.socketId === LENA_SOCKET_ID
        );

}

function assertLiveProjection(projection) {

    assert.equal(projection.confirmedSeats, 2);
    assert.equal(projection.mySeatStatus, "FUNDED");
    assert.equal(projection.depositAddress, DEPOSIT_ADDRESS);
    assert.equal(projection.phase, DEPOSIT_SESSION_STATUS.PARTIALLY_FUNDED);
    assert.equal(projection.activationStatus, "VERIFIED");
    assert.equal(projection.myExpectedAmountNanotons, FUNDSEAT_AMOUNT);
    assert.equal(projection.mySeatIndex, 2);
    assert.equal(
        Object.prototype.hasOwnProperty.call(projection, "package"),
        false,
        "live funded session must not re-expose the frozen package"
    );

}

function createGateway(stack) {

    return new SocketGateway({
        logger: stack.logger,
        socketConfig: { cors: { origin: "*" } },
        gameplayContextResolver: stack.gameplayContextResolver,
        roomLobbyBridge: stack.roomLobbyBridge,
        recoveryEngine: {
            recoverPlayer() {
                throw new Error("RecoveryEngine must not run in ENTRY_PAYMENT");
            },
            getDebugSnapshot() {
                return { currentState: null };
            }
        },
        recoverySnapshotCache: {
            get() {
                return null;
            }
        },
        devMode: true
    });

}

function fakeSocket() {

    return {
        id: LENA_SOCKET_ID,
        connected: true,
        on() {},
        emit() {}
    };

}

test("R18-S16: same-id protected SESSION_RECOVERY_REQUEST restores live 2/3 FUNDED", () => {

    const stack = buildStack();

    try {

        const { lenaId, session } = arrangeKeahRoom(stack);

        const boundBefore = stack.gameplayContextResolver.resolve(LENA_SOCKET_ID);

        assert.equal(boundBefore.ok, true, "resolver must stay bound after game start");

        stack.roomLobbyBridge._handleSocketDisconnected(LENA_SOCKET_ID, "transport close");

        const boundAfterDisconnect = stack.gameplayContextResolver.resolve(LENA_SOCKET_ID);

        assert.equal(
            boundAfterDisconnect.ok,
            true,
            "soft disconnect must not unbind GameplayContextResolver"
        );

        fundBobAndLena(session);

        const before = stack.deliveries.length;

        const gateway = createGateway(stack);

        gateway._handleRecoveryRequest(fakeSocket(), {
            type: RECOVERY_SOCKET_MESSAGE_TYPES.SESSION_RECOVERY_REQUEST,
            payload: {
                roomId: boundAfterDisconnect.roomId,
                playerId: lenaId
            }
        });

        const published = depositDeliveriesSince(stack, before);

        assert.equal(published.length, 1, "DEPOSIT_PACKAGE_PUBLISHED must be sent");

        assertLiveProjection(published[0].payload.deposit);

        assert.equal(
            session.metadata.depositPackage.bindings.every((binding) => binding.funded === false),
            true,
            "frozen publish-time bindings stay unfunded"
        );

    } finally {

        stack.shutdown();

    }

});

test("R18-S16: automatic Socket.IO connect without SESSION_RECOVERY_REQUEST restores Deposit", () => {

    const stack = buildStack();

    try {

        const { session } = arrangeKeahRoom(stack);

        stack.roomLobbyBridge._handleSocketDisconnected(LENA_SOCKET_ID, "ping timeout");

        fundBobAndLena(session);

        const before = stack.deliveries.length;

        const gateway = createGateway(stack);

        gateway._handleConnection(fakeSocket());

        const published = depositDeliveriesSince(stack, before);

        assert.equal(
            published.length,
            1,
            "protected_connect must send DEPOSIT_PACKAGE_PUBLISHED"
        );

        assertLiveProjection(published[0].payload.deposit);

    } finally {

        stack.shutdown();

    }

});

test("R18-S16: recovery projection uses live bindings, not frozen metadata snapshot", () => {

    const stack = buildStack();

    try {

        const { session } = arrangeKeahRoom(stack);

        fundBobAndLena(session);

        const before = stack.deliveries.length;

        const restored = stack.roomLobbyBridge.restoreDepositProjectionForSocket(
            LENA_SOCKET_ID,
            { reason: "test_live_bindings" }
        );

        assert.equal(restored.restored, true);
        assert.equal(restored.confirmedSeats, 2);
        assert.equal(restored.mySeatStatus, "FUNDED");

        const published = depositDeliveriesSince(stack, before);

        assertLiveProjection(published[0].payload.deposit);

        const frozenFunded = session.metadata.depositPackage.bindings
            .filter((binding) => binding.funded === true)
            .length;

        assert.equal(frozenFunded, 0);
        assert.notEqual(published[0].payload.deposit.confirmedSeats, frozenFunded);

    } finally {

        stack.shutdown();

    }

});

test("R18-S16: financial constants and setup timeout remain unchanged", () => {

    const config = loadRoomConfig({ ROOM_MAX_PLAYERS: "3" });

    assert.equal(config.setupDurationMs, 480000);
    assert.equal(config.paymentSessionDurationMs, 480000);
    assert.equal(Number(DEPLOY_VALUE_NANOTONS), 10000000);
    assert.equal(Number(CREATION_FEE_PER_SEAT), 1000000);
    assert.equal(EXPECTED_STAKE, 10000000);
        assert.equal(FUNDSEAT_AMOUNT, 11000000);

});

function captureInfo(stack) {

    const lines = [];
    const original = stack.logger.info.bind(stack.logger);

    stack.logger.info = (message, ...args) => {

        lines.push(String(message ?? ""));

        return original(message, ...args);

    };

    return lines;

}

function restoreLogsMatching(lines, event, reason) {

    return lines.filter((line) =>
        line.includes("[R18-S16 DepositRestore]")
        && line.includes(`event=${event}`)
        && (reason == null || line.includes(`reason=${reason}`))
    );

}

test("R18-S16: protected_connect restore emits RESTORE_ATTEMPT and RESTORE_RESULT", () => {

    const stack = buildStack();

    try {

        const { session, lenaId } = arrangeKeahRoom(stack);

        stack.roomLobbyBridge._handleSocketDisconnected(LENA_SOCKET_ID, "ping timeout");
        fundBobAndLena(session);

        const lines = captureInfo(stack);
        const gateway = createGateway(stack);

        gateway._handleConnection(fakeSocket());

        const attempts = restoreLogsMatching(lines, "RESTORE_ATTEMPT", "protected_connect");
        const results = restoreLogsMatching(lines, "RESTORE_RESULT", "protected_connect");
        const emitted = restoreLogsMatching(lines, "PROJECTION_EMITTED", "protected_connect");

        assert.equal(attempts.length, 1, "protected_connect must log RESTORE_ATTEMPT");
        assert.match(attempts[0], new RegExp(`playerId=${lenaId}`));
        assert.match(attempts[0], new RegExp(`socketId=${LENA_SOCKET_ID}`));

        assert.equal(results.length, 1, "protected_connect must log RESTORE_RESULT");
        assert.match(results[0], /restored=true/);
        assert.match(results[0], new RegExp(`depositAddress=${DEPOSIT_ADDRESS}`));
        assert.match(results[0], /state=PARTIALLY_FUNDED/);
        assert.match(results[0], /confirmedSeats=2/);
        assert.match(results[0], /mySeatStatus=FUNDED/);

        assert.equal(emitted.length, 1, "protected_connect must log PROJECTION_EMITTED");
        assert.match(emitted[0], new RegExp(`depositAddress=${DEPOSIT_ADDRESS}`));
        assert.match(emitted[0], /state=PARTIALLY_FUNDED/);
        assert.match(emitted[0], /confirmedSeats=2/);
        assert.match(emitted[0], /mySeatStatus=FUNDED/);

        assert.equal(
            lines.some((line) => /reclaim success/i.test(line)),
            false,
            "bound protected_connect must not reclaim"
        );

    } finally {

        stack.shutdown();

    }

});

test("R18-S16: bound_recovery restore emits RESTORE_ATTEMPT and live projection logs", () => {

    const stack = buildStack();

    try {

        const { session, lenaId } = arrangeKeahRoom(stack);

        stack.roomLobbyBridge._handleSocketDisconnected(LENA_SOCKET_ID, "transport close");
        fundBobAndLena(session);

        const bound = stack.gameplayContextResolver.resolve(LENA_SOCKET_ID);

        assert.equal(bound.ok, true);

        const lines = captureInfo(stack);
        const gateway = createGateway(stack);

        gateway._handleRecoveryRequest(fakeSocket(), {
            type: RECOVERY_SOCKET_MESSAGE_TYPES.SESSION_RECOVERY_REQUEST,
            payload: {
                roomId: bound.roomId,
                playerId: lenaId
            }
        });

        const attempts = restoreLogsMatching(lines, "RESTORE_ATTEMPT", "bound_recovery");
        const results = restoreLogsMatching(lines, "RESTORE_RESULT", "bound_recovery");
        const emitted = restoreLogsMatching(lines, "PROJECTION_EMITTED", "bound_recovery");

        assert.equal(attempts.length, 1, "bound_recovery must log RESTORE_ATTEMPT");
        assert.match(attempts[0], new RegExp(`playerId=${lenaId}`));
        assert.match(attempts[0], new RegExp(`socketId=${LENA_SOCKET_ID}`));

        assert.equal(results.length, 1, "bound_recovery must log RESTORE_RESULT");
        assert.match(results[0], /restored=true/);
        assert.match(results[0], new RegExp(`depositAddress=${DEPOSIT_ADDRESS}`));
        assert.match(results[0], /confirmedSeats=2/);
        assert.match(results[0], /mySeatStatus=FUNDED/);

        assert.equal(emitted.length, 1, "bound_recovery must log the emitted projection");
        assert.match(emitted[0], /confirmedSeats=2/);
        assert.match(emitted[0], /mySeatStatus=FUNDED/);
        assert.match(emitted[0], new RegExp(`depositAddress=${DEPOSIT_ADDRESS}`));

        assert.equal(
            lines.some((line) => /reclaim success/i.test(line)),
            false,
            "bound=true must skip reconnectSession reclaim"
        );

    } finally {

        stack.shutdown();

    }

});

function makeIsolationSession({ roomId, playerIds, fundedBySeat }) {

    const [bobId, lenaId, olgaId] = playerIds;
    const funded = fundedBySeat ?? [false, true, false];

    return {
        depositId: "dep_isolation_r18s16",
        roomId,
        gameId: GAME_ID,
        state: DEPOSIT_SESSION_STATUS.PARTIALLY_FUNDED,
        depositAddress: DEPOSIT_ADDRESS,
        bindings: [
            {
                playerId: bobId,
                wallet: "EQ_ISO_BOB_WALLET_00000000000000000000000000",
                expectedAmount: FUNDSEAT_AMOUNT,
                receivedAmount: funded[0] ? FUNDSEAT_AMOUNT : 0,
                funded: funded[0] === true
            },
            {
                playerId: lenaId,
                wallet: "EQ_ISO_LENA_WALLET_0000000000000000000000000",
                expectedAmount: FUNDSEAT_AMOUNT,
                receivedAmount: funded[1] ? FUNDSEAT_AMOUNT : 0,
                funded: funded[1] === true
            },
            {
                playerId: olgaId,
                wallet: "EQ_ISO_OLGA_WALLET_0000000000000000000000000",
                expectedAmount: FUNDSEAT_AMOUNT,
                receivedAmount: funded[2] ? FUNDSEAT_AMOUNT : 0,
                funded: funded[2] === true
            }
        ],
        metadata: {
            network: "testnet",
            creationFeePerSeat: Number(CREATION_FEE_PER_SEAT),
            depositPackage: {
                network: "testnet",
                deployValueNanotons: DEPLOY_VALUE_NANOTONS,
                stateInit: {
                    codeBoc: "te6ccgECCQAj/RASTl3GZs",
                    dataBoc: "abc123data"
                },
                bindings: [
                    {
                        playerId: bobId,
                        funded: false,
                        receivedAmount: 0,
                        expectedAmount: FUNDSEAT_AMOUNT,
                        expectedStake: EXPECTED_STAKE
                    },
                    {
                        playerId: lenaId,
                        funded: false,
                        receivedAmount: 0,
                        expectedAmount: FUNDSEAT_AMOUNT,
                        expectedStake: EXPECTED_STAKE
                    },
                    {
                        playerId: olgaId,
                        funded: false,
                        receivedAmount: 0,
                        expectedAmount: FUNDSEAT_AMOUNT,
                        expectedStake: EXPECTED_STAKE
                    }
                ]
            },
            activationVerification: {
                status: "VERIFIED",
                depositAddress: DEPOSIT_ADDRESS
            }
        }
    };

}

function arrangeIsolationRoom(stack) {

    const room = stack.roomManager.createRoom();
    const sockets = [BOB_SOCKET_ID, LENA_SOCKET_ID, OLGA_SOCKET_ID];
    const playerIds = [];

    for (const [index, nickname] of ["Bob", "Lena", "Olga"].entries()) {

        const player = stack.playerManager.createPlayer({ nickname });
        const playerId = player.identity.playerId;

        playerIds.push(playerId);
        stack.roomManager.addPlayer(room.roomId, playerId);
        stack.playerManager.updateRuntime(playerId, {
            roomId: room.roomId,
            gameId: GAME_ID
        });
        stack.roomLobbyBridge._registerSocketPlayer(sockets[index], playerId);
        stack.roomLobbyBridge._attachSocketToRoom(sockets[index], room.roomId);
        stack.playerManager.setConnectionState(playerId, CONNECTION_STATE.CONNECTED);

    }

    stack.roomLobbyBridge._roomCreators.set(room.roomId, playerIds[0]);
    stack.roomLobbyBridge._startedRooms.add(room.roomId);
    stack.gameplayContextResolver.activateRoomGame(room.roomId, GAME_ID);

    const session = makeIsolationSession({
        roomId: room.roomId,
        playerIds,
        fundedBySeat: [false, true, false]
    });

    stack.roomLobbyBridge._depositSessionCoordinator = stubCoordinator(session);

    return {
        room,
        session,
        seats: [
            {
                label: "Bob",
                playerId: playerIds[0],
                socketId: BOB_SOCKET_ID,
                mySeatIndex: 0,
                isCreator: true,
                mySeatStatus: "PENDING"
            },
            {
                label: "Lena",
                playerId: playerIds[1],
                socketId: LENA_SOCKET_ID,
                mySeatIndex: 1,
                isCreator: false,
                mySeatStatus: "FUNDED"
            },
            {
                label: "Olga",
                playerId: playerIds[2],
                socketId: OLGA_SOCKET_ID,
                mySeatIndex: 2,
                isCreator: false,
                mySeatStatus: "PENDING"
            }
        ]
    };

}

function fakeSocketWithId(socketId) {

    return {
        id: socketId,
        connected: true,
        on() {},
        emit() {}
    };

}

function depositPublishedSince(stack, before) {

    return stack.deliveries
        .slice(before)
        .filter((delivery) =>
            delivery.event === LOBBY_SERVER_EVENTS.DEPOSIT_PACKAGE_PUBLISHED
        );

}

function assertRecoveryOwnershipIndependent(bridge, seats, roomId) {

    const byPlayer = bridge._recoveryOwnershipByPlayer;
    const bySocket = bridge._recoveryOwnershipBySocket;

    assert.equal(byPlayer.size, 3, "three distinct player recovery entries");
    assert.equal(bySocket.size, 3, "three distinct socket recovery entries");

    const playerIds = seats.map((seat) => seat.playerId);
    const socketIds = seats.map((seat) => seat.socketId);

    assert.equal(new Set(playerIds).size, 3, "playerIds must be distinct");
    assert.equal(new Set(socketIds).size, 3, "socketIds must be distinct");

    for (const seat of seats) {

        const owned = byPlayer.get(seat.playerId);

        assert.ok(owned, `${seat.label} missing from _recoveryOwnershipByPlayer`);
        assert.equal(owned.socketId, seat.socketId, `${seat.label} player map must keep own socket`);
        assert.equal(owned.roomId, roomId, `${seat.label} player map must keep room`);

        const stashed = bySocket.get(seat.socketId);

        assert.ok(stashed, `${seat.label} missing from _recoveryOwnershipBySocket`);
        assert.equal(stashed.playerId, seat.playerId, `${seat.label} socket map must keep own player`);
        assert.equal(stashed.roomId, roomId, `${seat.label} socket map must keep room`);

        assert.equal(
            bridge._playerToSocket.get(seat.playerId),
            seat.socketId,
            `${seat.label} _playerToSocket must remain 1:1`
        );
        assert.equal(
            bridge._socketToPlayer.get(seat.socketId),
            seat.playerId,
            `${seat.label} _socketToPlayer must remain 1:1`
        );

    }

    const mappedSockets = [...byPlayer.values()].map((entry) => entry.socketId);
    const mappedPlayers = [...bySocket.values()].map((entry) => entry.playerId);

    assert.equal(new Set(mappedSockets).size, 3, "player ownership must not collapse onto one socket");
    assert.equal(new Set(mappedPlayers).size, 3, "socket ownership must not collapse onto one player");

}

function runProtectedIsolationSequence(stack, seats, restoreOrder) {

    const gateway = createGateway(stack);
    const lines = captureInfo(stack);
    const restoreResults = [];

    for (const seat of restoreOrder) {

        const before = stack.deliveries.length;
        const logBefore = lines.length;

        gateway._handleConnection(fakeSocketWithId(seat.socketId));

        const published = depositPublishedSince(stack, before);
        const attempts = restoreLogsMatching(
            lines.slice(logBefore),
            "RESTORE_ATTEMPT",
            "protected_connect"
        );
        const results = restoreLogsMatching(
            lines.slice(logBefore),
            "RESTORE_RESULT",
            "protected_connect"
        );

        assert.equal(attempts.length, 1, `${seat.label} must log one RESTORE_ATTEMPT`);
        assert.match(attempts[0], new RegExp(`playerId=${seat.playerId}`));
        assert.match(attempts[0], new RegExp(`socketId=${seat.socketId}`));

        assert.equal(results.length, 1, `${seat.label} must log one RESTORE_RESULT`);
        assert.match(results[0], /restored=true/);
        assert.match(results[0], new RegExp(`playerId=${seat.playerId}`));
        assert.match(results[0], new RegExp(`socketId=${seat.socketId}`));
        assert.match(results[0], new RegExp(`mySeatStatus=${seat.mySeatStatus}`));

        assert.equal(
            published.length,
            1,
            `${seat.label} restore must emit exactly one DEPOSIT_PACKAGE_PUBLISHED`
        );
        assert.equal(
            published[0].socketId,
            seat.socketId,
            `${seat.label} projection must go only to own socket`
        );

        const foreign = published.filter((delivery) => delivery.socketId !== seat.socketId);
        assert.equal(foreign.length, 0, `${seat.label} must not deliver to another socket`);

        const others = seats.filter((other) => other.socketId !== seat.socketId);

        for (const other of others) {

            assert.equal(
                published.some((delivery) => delivery.socketId === other.socketId),
                false,
                `${seat.label} must not send projection to ${other.label}`
            );

        }

        const projection = published[0].payload.deposit;

        assert.equal(projection.mySeatIndex, seat.mySeatIndex, `${seat.label} mySeatIndex`);
        assert.equal(projection.isCreator, seat.isCreator, `${seat.label} isCreator`);
        assert.equal(projection.mySeatStatus, seat.mySeatStatus, `${seat.label} mySeatStatus`);
        assert.equal(projection.myExpectedAmountNanotons, FUNDSEAT_AMOUNT, `${seat.label} own FundSeat`);
        assert.equal(projection.depositAddress, DEPOSIT_ADDRESS);
        assert.equal(projection.confirmedSeats, 1);

        restoreResults.push({
            label: seat.label,
            playerId: seat.playerId,
            socketId: seat.socketId,
            projection
        });

    }

    return restoreResults;

}

function assertEarlierRestoresUnchanged(restoreResults, seats) {

    for (const restored of restoreResults) {

        const seat = seats.find((entry) => entry.playerId === restored.playerId);

        assert.equal(restored.projection.mySeatIndex, seat.mySeatIndex);
        assert.equal(restored.projection.isCreator, seat.isCreator);
        assert.equal(restored.projection.mySeatStatus, seat.mySeatStatus);
        assert.equal(restored.socketId, seat.socketId);

    }

    assert.notEqual(restoreResults[0].playerId, restoreResults[1].playerId);
    assert.notEqual(restoreResults[1].playerId, restoreResults[2].playerId);
    assert.notEqual(restoreResults[0].playerId, restoreResults[2].playerId);

}

test("R18-S16: three players independently restore without identity collision", () => {

    const stack = buildStack();

    try {

        const { room, seats } = arrangeIsolationRoom(stack);

        assert.notEqual(seats[0].playerId, seats[1].playerId);
        assert.notEqual(seats[1].playerId, seats[2].playerId);
        assert.notEqual(seats[0].playerId, seats[2].playerId);
        assert.notEqual(seats[0].socketId, seats[1].socketId);
        assert.notEqual(seats[1].socketId, seats[2].socketId);
        assert.notEqual(seats[0].socketId, seats[2].socketId);

        for (const seat of seats) {

            stack.roomLobbyBridge._handleSocketDisconnected(seat.socketId, "transport close");
            assert.equal(
                stack.gameplayContextResolver.resolve(seat.socketId).ok,
                true,
                `${seat.label} must stay bound after protected soft disconnect`
            );

        }

        const restoreOrder = [seats[0], seats[1], seats[2]];
        const restoreResults = runProtectedIsolationSequence(stack, seats, restoreOrder);

        assert.equal(restoreResults.length, 3);
        assert.equal(restoreResults[0].label, "Bob");
        assert.equal(restoreResults[1].label, "Lena");
        assert.equal(restoreResults[2].label, "Olga");

        assertEarlierRestoresUnchanged(restoreResults, seats);
        assertRecoveryOwnershipIndependent(stack.roomLobbyBridge, seats, room.roomId);

        const lastPlayerOwnership = stack.roomLobbyBridge._recoveryOwnershipByPlayer.get(
            seats[2].playerId
        );
        const bobOwnership = stack.roomLobbyBridge._recoveryOwnershipByPlayer.get(
            seats[0].playerId
        );
        const lenaOwnership = stack.roomLobbyBridge._recoveryOwnershipByPlayer.get(
            seats[1].playerId
        );

        assert.equal(bobOwnership.socketId, BOB_SOCKET_ID);
        assert.equal(lenaOwnership.socketId, LENA_SOCKET_ID);
        assert.equal(lastPlayerOwnership.socketId, OLGA_SOCKET_ID);
        assert.notEqual(bobOwnership.socketId, lastPlayerOwnership.socketId);
        assert.notEqual(lenaOwnership.socketId, lastPlayerOwnership.socketId);

    } finally {

        stack.shutdown();

    }

});

test("R18-S16: three-player restore isolation does not depend on restore order", () => {

    const stack = buildStack();

    try {

        const { room, seats } = arrangeIsolationRoom(stack);

        for (const seat of seats) {

            stack.roomLobbyBridge._handleSocketDisconnected(seat.socketId, "ping timeout");

        }

        const restoreOrder = [seats[2], seats[0], seats[1]];
        const restoreResults = runProtectedIsolationSequence(stack, seats, restoreOrder);

        assert.equal(restoreResults[0].label, "Olga");
        assert.equal(restoreResults[1].label, "Bob");
        assert.equal(restoreResults[2].label, "Lena");
        assertEarlierRestoresUnchanged(restoreResults, seats);
        assertRecoveryOwnershipIndependent(stack.roomLobbyBridge, seats, room.roomId);

    } finally {

        stack.shutdown();

    }

});

