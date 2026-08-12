/**
 * R13.1E — Identity recovery credential authorization boundary.
 */
import { EventBus } from "../events/EventBus.js";
import { CONNECTION_STATE } from "../models/ConnectionState.js";
import { PlayerManager } from "../managers/PlayerManager.js";
import { RoomManager } from "../managers/RoomManager.js";
import { LoggerService } from "../services/LoggerService.js";
import { GameplayContextResolver } from "../socket/GameplayContextResolver.js";
import { RoomLobbyBridge } from "../socket/RoomLobbyBridge.js";
import { SetupSessionLifecycle } from "../gameplay/SetupSessionLifecycle.js";
import {
    RECOVERY_AUTH_REASONS
} from "../gameplay/RecoveryCredentialStore.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

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
        roomManager
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

    return {
        logger,
        eventBus,
        playerManager,
        roomManager,
        setupSessionLifecycle,
        roomLobbyBridge,
        gameplayContextResolver,
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

function seatPlayer(stack, {
    socketId,
    nickname = "P",
    startGameplay = true,
    gameId = "game-r131e"
} = {}) {

    const room = stack.roomManager.createRoom();

    const player = stack.playerManager.createPlayer({ nickname });

    const playerId = player.identity.playerId;

    stack.roomManager.addPlayer(room.roomId, playerId);

    stack.playerManager.updateRuntime(playerId, { roomId: room.roomId });

    stack.roomLobbyBridge._registerSocketPlayer(socketId, playerId);

    stack.roomLobbyBridge._attachSocketToRoom(socketId, room.roomId);

    stack.playerManager.setConnectionState(playerId, CONNECTION_STATE.CONNECTED);

    const recoveryCredential = stack.roomLobbyBridge.issueRecoveryCredential(
        playerId,
        room.roomId
    );

    if (startGameplay) {

        stack.roomLobbyBridge._startedRooms.add(room.roomId);

        stack.gameplayContextResolver.activateRoomGame(room.roomId, gameId);

        stack.playerManager.updateRuntime(playerId, {
            roomId: room.roomId,
            gameId
        });

    }

    return {
        roomId: room.roomId,
        playerId,
        recoveryCredential
    };

}

console.log("R13.1E identity recovery credential tests");

{

    const stack = buildStack();

    try {

        const seat = seatPlayer(stack, { socketId: "sock-a" });

        stack.roomLobbyBridge._handleSocketDisconnected("sock-a");

        const result = stack.roomLobbyBridge.reconnectGameplaySession(
            "sock-b",
            {
                playerId: seat.playerId,
                roomId: seat.roomId,
                recoveryCredential: seat.recoveryCredential
            }
        );

        assert(result.ok, "1. valid credential must recover");
        assert(result.playerId === seat.playerId, "1. player must match");
        console.log("  1. valid credential → success");

    } finally {

        stack.shutdown();

    }

}

{

    const stack = buildStack();

    try {

        const seat = seatPlayer(stack, { socketId: "sock-a" });

        stack.roomLobbyBridge._handleSocketDisconnected("sock-a");

        const result = stack.roomLobbyBridge.reconnectGameplaySession(
            "sock-b",
            {
                playerId: seat.playerId,
                roomId: seat.roomId
            }
        );

        assert(!result.ok, "2. missing credential must reject");

        const auth = stack.roomLobbyBridge.authorizeRecoveryCredential({
            playerId: seat.playerId,
            roomId: seat.roomId,
            credential: null
        });

        assert(
            auth.reason === RECOVERY_AUTH_REASONS.MISSING,
            "2. reason must be RECOVERY_AUTH_MISSING"
        );

        console.log("  2. missing credential → rejected");

    } finally {

        stack.shutdown();

    }

}

{

    const stack = buildStack();

    try {

        const seat = seatPlayer(stack, { socketId: "sock-a" });

        stack.roomLobbyBridge._handleSocketDisconnected("sock-a");

        const result = stack.roomLobbyBridge.reconnectGameplaySession(
            "sock-b",
            {
                playerId: seat.playerId,
                roomId: seat.roomId,
                recoveryCredential: "not-a-real-credential"
            }
        );

        assert(!result.ok, "3. invalid credential must reject");

        const auth = stack.roomLobbyBridge.authorizeRecoveryCredential({
            playerId: seat.playerId,
            roomId: seat.roomId,
            credential: "not-a-real-credential"
        });

        assert(
            auth.reason === RECOVERY_AUTH_REASONS.INVALID,
            "3. reason must be RECOVERY_AUTH_INVALID"
        );

        console.log("  3. invalid credential → rejected");

    } finally {

        stack.shutdown();

    }

}

{

    const stack = buildStack();

    try {

        const a = seatPlayer(stack, {
            socketId: "sock-a",
            nickname: "A",
            gameId: "game-a"
        });

        const b = seatPlayer(stack, {
            socketId: "sock-b",
            nickname: "B",
            gameId: "game-b"
        });

        stack.roomLobbyBridge._handleSocketDisconnected("sock-b");

        const result = stack.roomLobbyBridge.reconnectGameplaySession(
            "sock-attacker",
            {
                playerId: b.playerId,
                roomId: b.roomId,
                recoveryCredential: a.recoveryCredential
            }
        );

        assert(!result.ok, "4. cross-player credential must reject");

        const auth = stack.roomLobbyBridge.authorizeRecoveryCredential({
            playerId: b.playerId,
            roomId: b.roomId,
            credential: a.recoveryCredential
        });

        assert(
            auth.reason === RECOVERY_AUTH_REASONS.PLAYER_MISMATCH,
            "4. reason must be RECOVERY_AUTH_PLAYER_MISMATCH"
        );

        console.log("  4. A credential + B playerId → rejected");

    } finally {

        stack.shutdown();

    }

}

{

    const stack = buildStack();

    try {

        const a = seatPlayer(stack, {
            socketId: "sock-a",
            nickname: "A",
            gameId: "game-a"
        });

        const b = seatPlayer(stack, {
            socketId: "sock-b",
            nickname: "B",
            gameId: "game-b"
        });

        stack.roomLobbyBridge._handleSocketDisconnected("sock-a");

        const result = stack.roomLobbyBridge.reconnectGameplaySession(
            "sock-attacker",
            {
                playerId: a.playerId,
                roomId: b.roomId,
                recoveryCredential: a.recoveryCredential
            }
        );

        assert(!result.ok, "5. wrong roomId must reject");

        const auth = stack.roomLobbyBridge.authorizeRecoveryCredential({
            playerId: a.playerId,
            roomId: b.roomId,
            credential: a.recoveryCredential
        });

        assert(
            auth.reason === RECOVERY_AUTH_REASONS.ROOM_MISMATCH,
            "5. reason must be RECOVERY_AUTH_ROOM_MISMATCH"
        );

        console.log("  5. A credential + B roomId → rejected");

    } finally {

        stack.shutdown();

    }

}

{

    const stack = buildStack();

    try {

        const seat = seatPlayer(stack, { socketId: "sock-a" });

        stack.roomLobbyBridge._handleSocketDisconnected("sock-a");

        const result = stack.roomLobbyBridge.reconnectGameplaySession(
            "sock-b",
            {
                playerId: seat.playerId,
                roomId: seat.roomId,
                recoveryCredential: ""
            }
        );

        assert(!result.ok, "6. empty credential must reject");
        console.log("  6. known playerId without credential → rejected");

    } finally {

        stack.shutdown();

    }

}

{

    const stack = buildStack();

    try {

        const seat = seatPlayer(stack, { socketId: "sock-live" });

        stack.roomLobbyBridge._handleSocketDisconnected("sock-live");

        const result = stack.roomLobbyBridge.reconnectGameplaySession(
            "sock-new",
            {
                playerId: seat.playerId,
                roomId: seat.roomId,
                recoveryCredential: seat.recoveryCredential
            }
        );

        assert(result.ok, "7. reconnect must succeed");
        assert(
            stack.roomLobbyBridge._playerToSocket.get(seat.playerId) === "sock-new",
            "7. socket must rebind"
        );
        console.log("  7. valid reconnect after disconnect → succeeds");

    } finally {

        stack.shutdown();

    }

}

{

    const stack = buildStack();

    try {

        const seat = seatPlayer(stack, {
            socketId: "sock-tg",
            startGameplay: false
        });

        assert(
            stack.setupSessionLifecycle.isRecoverable(seat.roomId),
            "8. setup must be recoverable"
        );

        stack.roomLobbyBridge._handleSocketDisconnected("sock-tg");

        const result = stack.roomLobbyBridge.reconnectGameplaySession(
            "sock-tg-reopen",
            {
                playerId: seat.playerId,
                roomId: seat.roomId,
                recoveryCredential: seat.recoveryCredential
            }
        );

        assert(result.ok, "8. setup/web recovery must succeed");
        console.log("  8. valid Telegram/Web recovery → succeeds");

    } finally {

        stack.shutdown();

    }

}

void (async () => {

    const stack = buildStack();

    try {

        const seat = seatPlayer(stack, { socketId: "sock-a" });

        stack.roomLobbyBridge._handleSocketDisconnected("sock-a");

        await stack.roomLobbyBridge._closeRoom(seat.roomId, "test_terminal");

        const auth = stack.roomLobbyBridge.authorizeRecoveryCredential({
            playerId: seat.playerId,
            roomId: seat.roomId,
            credential: seat.recoveryCredential
        });

        assert(!auth.ok, "9. credential must be invalid after room close");

        const result = stack.roomLobbyBridge.reconnectGameplaySession(
            "sock-late",
            {
                playerId: seat.playerId,
                roomId: seat.roomId,
                recoveryCredential: seat.recoveryCredential
            }
        );

        assert(!result.ok, "9. reclaim after terminal cleanup must fail");
        console.log("  9. terminal cleanup invalidates recovery");

    } finally {

        stack.shutdown();

    }

})();

{

    const stack = buildStack();

    try {

        const seat = seatPlayer(stack, { socketId: "sock-victim" });

        const reclaim = stack.roomLobbyBridge.reconnectGameplaySession(
            "sock-attacker",
            {
                playerId: seat.playerId,
                roomId: seat.roomId
            }
        );

        assert(!reclaim.ok, "attacker playerId-only reclaim must fail");
        console.log("  extra. playerId-only reclaim rejected");

    } finally {

        stack.shutdown();

    }

}

console.log("R13.1E identity recovery credential tests passed");
