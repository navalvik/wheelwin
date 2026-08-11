/**
 * R13.1B — Post GAME_INITIALIZED room protection against LEAVE_ROOM.
 */
import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { CONNECTION_STATE } from "../models/ConnectionState.js";
import { PlayerManager } from "../managers/PlayerManager.js";
import { RoomManager } from "../managers/RoomManager.js";
import { LoggerService } from "../services/LoggerService.js";
import { GameplayContextResolver } from "../socket/GameplayContextResolver.js";
import { RoomLobbyBridge } from "../socket/RoomLobbyBridge.js";
import { SetupSessionLifecycle } from "../gameplay/SetupSessionLifecycle.js";
import { ResultSessionLifecycle } from "../gameplay/ResultSessionLifecycle.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

function buildStack({ resultSessionDurationMs = 60_000 } = {}) {

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
        roomConfig: { setupDurationMs: 10 * 60 * 1000 }
    });

    setupSessionLifecycle.initialize();

    roomManager.attachSetupSessionLifecycle(setupSessionLifecycle);

    const resultSessionLifecycle = new ResultSessionLifecycle({
        logger,
        eventBus,
        roomConfig: { resultSessionDurationMs }
    });

    resultSessionLifecycle.initialize();

    const initializedRooms = new Set();

    const paymentSessionManager = {
        _gameManager: {
            hasInitializedGameplay(roomId) {

                return initializedRooms.has(roomId);

            },
            getGameIdByRoomId() {

                return null;

            },
            wasEntryPaymentActivated() {

                return false;

            }
        },
        destroySession() {},
        getSession() {

            return null;

        }
    };

    const roomLobbyBridge = new RoomLobbyBridge({
        logger,
        eventBus,
        roomManager,
        playerManager,
        gameplayContextResolver,
        setupSessionLifecycle,
        resultSessionLifecycle,
        paymentSessionManager
    });

    roomLobbyBridge.initialize();

    const sessionFinished = [];

    const roomDestroyed = [];

    eventBus.subscribe(EVENT_TYPES.SESSION_FINISHED, (envelope) => {

        sessionFinished.push(envelope.payload);

    });

    eventBus.subscribe(EVENT_TYPES.ROOM_DESTROYED, (envelope) => {

        roomDestroyed.push(envelope.payload);

    });

    return {
        playerManager,
        roomManager,
        roomLobbyBridge,
        setupSessionLifecycle,
        resultSessionLifecycle,
        initializedRooms,
        sessionFinished,
        roomDestroyed,
        markInitialized(roomId) {

            initializedRooms.add(roomId);

            setupSessionLifecycle._releaseGameplayOwnership?.(roomId);

            roomLobbyBridge._startedRooms.add(roomId);

        },
        shutdown() {

            roomLobbyBridge.shutdown();

            resultSessionLifecycle.shutdown();

            setupSessionLifecycle.shutdown();

            roomManager.shutdown();

            playerManager.shutdown();

            eventBus.shutdown();

            logger.shutdown();

        }
    };

}

function seatThreePlayers(stack) {

    const room = stack.roomManager.createRoom();

    const roomId = room.roomId;

    const seats = [];

    for (let i = 0; i < 3; i += 1) {

        const player = stack.playerManager.createPlayer({
            nickname: `P${i + 1}`
        });

        const playerId = player.identity.playerId;

        const socketId = `sock-${i + 1}`;

        stack.roomManager.addPlayer(roomId, playerId);

        stack.playerManager.updateRuntime(playerId, { roomId });

        stack.roomLobbyBridge._registerSocketPlayer(socketId, playerId);

        stack.roomLobbyBridge._attachSocketToRoom(socketId, roomId);

        stack.playerManager.setConnectionState(
            playerId,
            CONNECTION_STATE.CONNECTED
        );

        if (i === 0) {

            stack.roomLobbyBridge._roomCreators.set(roomId, playerId);

        }

        seats.push({ playerId, socketId });

    }

    return { roomId, seats };

}

function leave(stack, socketId) {

    stack.roomLobbyBridge._handleLeaveRoom(socketId);

}

function onlineCount(stack, roomId) {

    const room = stack.roomManager.getRoom(roomId);

    if (!room) {

        return 0;

    }

    return room.players.filter((playerId) => {

        const runtime = stack.playerManager.getRuntime(playerId);

        return runtime?.connectionState === CONNECTION_STATE.CONNECTED;

    }).length;

}

// ---------------------------------------------------------------------------
// Test A — one LEAVE_ROOM during protected SPEED-equivalent state
// ---------------------------------------------------------------------------

{

    const stack = buildStack();

    try {

        const { roomId, seats } = seatThreePlayers(stack);

        stack.markInitialized(roomId);

        leave(stack, seats[0].socketId);

        assert(
            stack.roomManager.getRoom(roomId)?.players.length === 3,
            "TEST A: seat must remain after leave during active gameplay"
        );

        assert(
            onlineCount(stack, roomId) === 2,
            "TEST A: leaver is offline; others remain online"
        );

        assert(
            stack.sessionFinished.length === 0,
            "TEST A: no SESSION_FINISHED"
        );

        assert(
            stack.roomDestroyed.length === 0,
            "TEST A: no ROOM_DESTROYED"
        );

        console.log("  TEST A leave during SPEED: OK");

    } finally {

        stack.shutdown();

    }

}

// ---------------------------------------------------------------------------
// Test B — all players LEAVE_ROOM during active gameplay
// ---------------------------------------------------------------------------

{

    const stack = buildStack();

    try {

        const { roomId, seats } = seatThreePlayers(stack);

        stack.markInitialized(roomId);

        for (const seat of seats) {

            leave(stack, seat.socketId);

        }

        assert(
            stack.roomManager.getRoom(roomId)?.players.length === 3,
            "TEST B: all seats remain"
        );

        assert(
            onlineCount(stack, roomId) === 0,
            "TEST B: 0 online players"
        );

        assert(
            stack.sessionFinished.length === 0,
            "TEST B: no SESSION_FINISHED(session_ended)"
        );

        assert(
            stack.roomDestroyed.length === 0,
            "TEST B: room must not be destroyed"
        );

        console.log("  TEST B all players leave during SPEED: OK");

    } finally {

        stack.shutdown();

    }

}

// ---------------------------------------------------------------------------
// Test C — leave during BRAKE-equivalent protected state (same boundary)
// ---------------------------------------------------------------------------

{

    const stack = buildStack();

    try {

        const { roomId, seats } = seatThreePlayers(stack);

        stack.markInitialized(roomId);

        leave(stack, seats[1].socketId);

        leave(stack, seats[2].socketId);

        assert(
            stack.roomManager.getRoom(roomId) != null,
            "TEST C: room remains during BRAKE-equivalent leave"
        );

        assert(
            stack.sessionFinished.length === 0,
            "TEST C: no premature terminal"
        );

        console.log("  TEST C leave during BRAKE: OK");

    } finally {

        stack.shutdown();

    }

}

// ---------------------------------------------------------------------------
// Test D — leave during RESULT before Result Session / Page6
// ---------------------------------------------------------------------------

{

    const stack = buildStack();

    try {

        const { roomId, seats } = seatThreePlayers(stack);

        stack.markInitialized(roomId);

        for (const seat of seats) {

            leave(stack, seat.socketId);

        }

        assert(
            stack.roomManager.getRoom(roomId)?.players.length === 3,
            "TEST D: RESULT pre-Page6 leave keeps seats"
        );

        assert(
            stack.sessionFinished.length === 0,
            "TEST D: result lifecycle not finished by leave"
        );

        console.log("  TEST D leave during RESULT before terminal: OK");

    } finally {

        stack.shutdown();

    }

}

// ---------------------------------------------------------------------------
// Test E — all soft disconnects keep room (regression)
// ---------------------------------------------------------------------------

{

    const stack = buildStack();

    try {

        const { roomId, seats } = seatThreePlayers(stack);

        stack.markInitialized(roomId);

        for (const seat of seats) {

            stack.roomLobbyBridge._handleSocketDisconnected(seat.socketId);

        }

        assert(
            stack.roomManager.getRoom(roomId)?.players.length === 3,
            "TEST E: disconnect keeps seats"
        );

        assert(
            stack.roomDestroyed.length === 0,
            "TEST E: no room destroy on disconnect"
        );

        console.log("  TEST E all players offline via disconnect: OK");

    } finally {

        stack.shutdown();

    }

}

// ---------------------------------------------------------------------------
// Test F — setup leave may destroy empty room
// ---------------------------------------------------------------------------

{

    const stack = buildStack();

    try {

        const { roomId, seats } = seatThreePlayers(stack);

        // No markInitialized / no _startedRooms — pre-gameplay setup leave.
        for (const seat of seats) {

            leave(stack, seat.socketId);

        }

        assert(
            stack.roomManager.getRoom(roomId) == null,
            "TEST F: empty setup room may be destroyed"
        );

        assert(
            stack.roomDestroyed.length >= 1,
            "TEST F: ROOM_DESTROYED emitted for empty setup"
        );

        console.log("  TEST F setup leave destroys empty room: OK");

    } finally {

        stack.shutdown();

    }

}

// ---------------------------------------------------------------------------
// Test G — completed game / Result Session leave may finish room
// ---------------------------------------------------------------------------

{

    const stack = buildStack();

    try {

        const { roomId, seats } = seatThreePlayers(stack);

        stack.markInitialized(roomId);

        stack.resultSessionLifecycle.start(roomId, { gameId: "g-r131b" });

        assert(
            stack.resultSessionLifecycle.isActive(roomId) === true,
            "TEST G: Result Session active (Page6)"
        );

        for (const seat of seats) {

            leave(stack, seat.socketId);

        }

        assert(
            stack.sessionFinished.some(
                (payload) => payload?.roomId === roomId
                    && payload?.reason === "session_ended"
            ),
            "TEST G: SESSION_FINISHED after last Page6 leave"
        );

        assert(
            stack.roomManager.getRoom(roomId) == null,
            "TEST G: room cleaned after terminal leave"
        );

        console.log("  TEST G completed Page6 leave cleanup: OK");

    } finally {

        stack.shutdown();

    }

}

console.log("roomProtection.r131b.test.js: all assertions passed");
