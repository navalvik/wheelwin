/**
 * R1.2B — RC-2 Session rebind hardening.
 *
 * Verifies exclusive player → socket ownership. One player may have exactly one
 * authoritative binding at any moment; obsolete sockets cannot submit gameplay.
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

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

function buildRebindStack() {

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
        gameplayContextResolver,
        roomLobbyBridge,
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

function bindStartedPlayer(stack, {
    socketId,
    playerId,
    roomId,
    gameId
}) {

    stack.roomLobbyBridge._registerSocketPlayer(socketId, playerId);

    stack.roomLobbyBridge._attachSocketToRoom(socketId, roomId);

    stack.roomLobbyBridge._startedRooms.add(roomId);

    stack.gameplayContextResolver.activateRoomGame(roomId, gameId);

    stack.playerManager.updateRuntime(playerId, {
        roomId,
        gameId
    });

    stack.playerManager.setConnectionState(
        playerId,
        CONNECTION_STATE.CONNECTED
    );

}

function tryGameplayInput(stack, socketId, playerId) {

    const context = stack.gameplayContextResolver.resolve(socketId);

    if (!context.ok) {

        return { ok: false, reason: context.reason };

    }

    return {
        ok: true,
        playerId: context.playerId,
        accepted: context.playerId === playerId
    };

}

// ---------------------------------------------------------------------------
// Scenario 1 — second lobby bind evicts the first socket.
// ---------------------------------------------------------------------------

{

    const stack = buildRebindStack();

    try {

        const room = stack.roomManager.createRoom();

        const player = stack.playerManager.createPlayer({ nickname: "Solo" });

        const playerId = player.identity.playerId;

        stack.roomManager.addPlayer(room.roomId, playerId);

        stack.playerManager.updateRuntime(playerId, { roomId: room.roomId });

        bindStartedPlayer(stack, {
            socketId: "socket-a",
            playerId,
            roomId: room.roomId,
            gameId: "game-rebind-1"
        });

        stack.roomLobbyBridge._registerSocketPlayer("socket-b", playerId);

        assert(
            stack.roomLobbyBridge._playerToSocket.get(playerId) === "socket-b",
            "player must map to the latest socket only"
        );

        assert(
            !stack.roomLobbyBridge._socketToPlayer.has("socket-a"),
            "evicted socket must leave lobby ownership"
        );

        assert(
            stack.roomLobbyBridge._socketToPlayer.get("socket-b") === playerId,
            "new socket must own the player"
        );

        console.log("  scenario 1 (dual lobby bind evicts first socket) passed");

    } finally {

        stack.shutdown();

    }

}

// ---------------------------------------------------------------------------
// Scenario 2 — second gameplay bind evicts the first socket.
// ---------------------------------------------------------------------------

{

    const stack = buildRebindStack();

    try {

        const room = stack.roomManager.createRoom();

        const player = stack.playerManager.createPlayer({ nickname: "Solo" });

        const playerId = player.identity.playerId;

        stack.roomManager.addPlayer(room.roomId, playerId);

        stack.playerManager.updateRuntime(playerId, { roomId: room.roomId });

        bindStartedPlayer(stack, {
            socketId: "socket-a",
            playerId,
            roomId: room.roomId,
            gameId: "game-rebind-2"
        });

        stack.gameplayContextResolver.bindSocket("socket-b", {
            playerId,
            roomId: room.roomId
        });

        const obsolete = stack.gameplayContextResolver.resolve("socket-a");

        assert(!obsolete.ok, "obsolete socket must not resolve gameplay context");

        const authoritative = stack.gameplayContextResolver.resolve("socket-b");

        assert(authoritative.ok, "new socket must resolve gameplay context");

        assert(
            authoritative.playerId === playerId,
            "authoritative socket must own the player session"
        );

        console.log("  scenario 2 (dual gameplay bind evicts first socket) passed");

    } finally {

        stack.shutdown();

    }

}

// ---------------------------------------------------------------------------
// Scenario 3 — rebinding an active player evicts the previous socket.
// ---------------------------------------------------------------------------

{

    const stack = buildRebindStack();

    try {

        const room = stack.roomManager.createRoom();

        const player = stack.playerManager.createPlayer({ nickname: "Victim" });

        const playerId = player.identity.playerId;

        stack.roomManager.addPlayer(room.roomId, playerId);

        stack.playerManager.updateRuntime(playerId, { roomId: room.roomId });

        bindStartedPlayer(stack, {
            socketId: "socket-victim",
            playerId,
            roomId: room.roomId,
            gameId: "game-rebind-3"
        });

        stack.roomLobbyBridge._registerSocketPlayer("socket-attacker", playerId);

        stack.roomLobbyBridge._attachSocketToRoom(
            "socket-attacker",
            room.roomId
        );

        assert(
            stack.roomLobbyBridge._playerToSocket.get(playerId) === "socket-attacker",
            "rebind must move authoritative ownership to the challenger"
        );

        assert(
            !stack.roomLobbyBridge._socketToPlayer.has("socket-victim"),
            "previous socket must lose lobby ownership"
        );

        const obsoleteInput = tryGameplayInput(
            stack,
            "socket-victim",
            playerId
        );

        assert(!obsoleteInput.ok, "obsolete socket must not submit gameplay input");

        const liveInput = tryGameplayInput(
            stack,
            "socket-attacker",
            playerId
        );

        assert(liveInput.ok, "authoritative socket must still submit gameplay input");

        console.log("  scenario 3 (rebind evicts active socket) passed");

    } finally {

        stack.shutdown();

    }

}

// ---------------------------------------------------------------------------
// Scenario 4 — legitimate soft-disconnect reconnect remains exclusive.
// ---------------------------------------------------------------------------

{

    const stack = buildRebindStack();

    try {

        const room = stack.roomManager.createRoom();

        const player = stack.playerManager.createPlayer({ nickname: "Returnee" });

        const playerId = player.identity.playerId;

        stack.roomManager.addPlayer(room.roomId, playerId);

        stack.playerManager.updateRuntime(playerId, { roomId: room.roomId });

        bindStartedPlayer(stack, {
            socketId: "socket-a",
            playerId,
            roomId: room.roomId,
            gameId: "game-rebind-4"
        });

        stack.roomLobbyBridge._handleSocketDisconnected("socket-a");

        const reconnected = stack.roomLobbyBridge.reconnectGameplaySession("socket-a");

        assert(reconnected.ok, "legitimate reconnect must succeed");

        assert(
            stack.roomLobbyBridge._playerToSocket.get(playerId) === "socket-a",
            "reconnected player must own exactly one socket"
        );

        const gameplay = stack.gameplayContextResolver.resolve("socket-a");

        assert(gameplay.ok, "reconnected socket must resolve gameplay");

        console.log("  scenario 4 (legitimate reconnect exclusive) passed");

    } finally {

        stack.shutdown();

    }

}

// ---------------------------------------------------------------------------
// Scenario 5 — parallel reconnect attempt without ownership fails safely.
// ---------------------------------------------------------------------------

{

    const stack = buildRebindStack();

    try {

        const room = stack.roomManager.createRoom();

        const player = stack.playerManager.createPlayer({ nickname: "Solo" });

        const playerId = player.identity.playerId;

        stack.roomManager.addPlayer(room.roomId, playerId);

        stack.playerManager.updateRuntime(playerId, { roomId: room.roomId });

        bindStartedPlayer(stack, {
            socketId: "socket-a",
            playerId,
            roomId: room.roomId,
            gameId: "game-rebind-5"
        });

        stack.roomLobbyBridge._handleSocketDisconnected("socket-a");

        const legitimate = stack.roomLobbyBridge.reconnectGameplaySession("socket-a");

        assert(legitimate.ok, "first reconnect must succeed");

        const parallel = stack.roomLobbyBridge.reconnectGameplaySession("socket-b");

        assert(!parallel.ok, "parallel reconnect without ownership must fail");

        assert(
            stack.roomLobbyBridge._playerToSocket.get(playerId) === "socket-a",
            "ownership must remain with the first successful reconnect"
        );

        console.log("  scenario 5 (parallel reconnect rejected) passed");

    } finally {

        stack.shutdown();

    }

}

// ---------------------------------------------------------------------------
// Scenario 6 — refresh during gameplay transfers exclusive ownership.
// ---------------------------------------------------------------------------

{

    const stack = buildRebindStack();

    try {

        const room = stack.roomManager.createRoom();

        const player = stack.playerManager.createPlayer({ nickname: "Refresh" });

        const playerId = player.identity.playerId;

        stack.roomManager.addPlayer(room.roomId, playerId);

        stack.playerManager.updateRuntime(playerId, { roomId: room.roomId });

        bindStartedPlayer(stack, {
            socketId: "socket-old",
            playerId,
            roomId: room.roomId,
            gameId: "game-rebind-6"
        });

        stack.roomLobbyBridge._handleSocketDisconnected("socket-old");

        assert(
            stack.roomLobbyBridge.transferRecoveryOwnership(
                "socket-old",
                "socket-refresh"
            ),
            "refresh must transfer server-owned recovery identity"
        );

        const refreshed = stack.roomLobbyBridge.reconnectGameplaySession(
            "socket-refresh"
        );

        assert(refreshed.ok, "refresh reconnect must succeed");

        assert(
            !stack.gameplayContextResolver.resolve("socket-old").ok,
            "old socket must not retain gameplay authority after refresh"
        );

        assert(
            stack.gameplayContextResolver.resolve("socket-refresh").ok,
            "refreshed socket must gain gameplay authority"
        );

        console.log("  scenario 6 (refresh during gameplay) passed");

    } finally {

        stack.shutdown();

    }

}

// ---------------------------------------------------------------------------
// Scenario 7 — setup session reconnect remains exclusive.
// ---------------------------------------------------------------------------

{

    const stack = buildRebindStack();

    try {

        const room = stack.roomManager.createRoom();

        const player = stack.playerManager.createPlayer({ nickname: "Setup" });

        const playerId = player.identity.playerId;

        stack.roomManager.addPlayer(room.roomId, playerId);

        stack.playerManager.updateRuntime(playerId, { roomId: room.roomId });

        stack.roomLobbyBridge._registerSocketPlayer("socket-setup-a", playerId);

        stack.roomLobbyBridge._attachSocketToRoom("socket-setup-a", room.roomId);

        stack.roomLobbyBridge._startedRooms.add(room.roomId);

        stack.eventBus.emit({
            source: "test",
            type: EVENT_TYPES.SETUP_SESSION_STARTED,
            payload: { roomId: room.roomId }
        });

        stack.roomLobbyBridge._handleSocketDisconnected("socket-setup-a");

        assert(
            stack.roomLobbyBridge.transferRecoveryOwnership(
                "socket-setup-a",
                "socket-setup-b"
            ),
            "setup reconnect must transfer recovery ownership"
        );

        const reconnected = stack.roomLobbyBridge.reconnectGameplaySession(
            "socket-setup-b"
        );

        assert(reconnected.ok, "setup reconnect must succeed");

        assert(
            stack.roomLobbyBridge._playerToSocket.get(playerId) === "socket-setup-b",
            "setup reconnect must leave one authoritative socket"
        );

        assert(
            !stack.roomLobbyBridge._socketToPlayer.has("socket-setup-a"),
            "previous setup socket must be evicted"
        );

        console.log("  scenario 7 (setup session rebind) passed");

    } finally {

        stack.shutdown();

    }

}

// ---------------------------------------------------------------------------
// Scenario 8 — gameplay reconnect evicts a stale parallel lobby bind.
// ---------------------------------------------------------------------------

{

    const stack = buildRebindStack();

    try {

        const room = stack.roomManager.createRoom();

        const player = stack.playerManager.createPlayer({ nickname: "Returnee" });

        const playerId = player.identity.playerId;

        stack.roomManager.addPlayer(room.roomId, playerId);

        stack.playerManager.updateRuntime(playerId, { roomId: room.roomId });

        bindStartedPlayer(stack, {
            socketId: "socket-a",
            playerId,
            roomId: room.roomId,
            gameId: "game-rebind-8"
        });

        stack.roomLobbyBridge._handleSocketDisconnected("socket-a");

        stack.roomLobbyBridge._registerSocketPlayer("socket-stale", playerId);

        const reconnected = stack.roomLobbyBridge.reconnectGameplaySession("socket-a");

        assert(reconnected.ok, "authorized reconnect must succeed");

        assert(
            stack.roomLobbyBridge._playerToSocket.get(playerId) === "socket-a",
            "reconnect must restore the authoritative socket"
        );

        assert(
            !stack.roomLobbyBridge._socketToPlayer.has("socket-stale"),
            "stale parallel bind must be evicted"
        );

        assert(
            stack.gameplayContextResolver.resolve("socket-a").ok,
            "reconnected socket must regain gameplay authority"
        );

        console.log("  scenario 8 (reconnect evicts stale bind) passed");

    } finally {

        stack.shutdown();

    }

}

console.log("sessionRebind.integration.test.js: all assertions passed");
