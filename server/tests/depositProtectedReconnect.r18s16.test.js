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
const LENA_SOCKET_ID = "c0QikAAlyHNBuzbvAAFc";

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
