/**
 * R6.1 — Setup Session soft disconnect + playerId reclaim.
 */
import { EventBus } from "../events/EventBus.js";
import { CONNECTION_STATE } from "../models/ConnectionState.js";
import { PlayerManager } from "../managers/PlayerManager.js";
import { RoomManager } from "../managers/RoomManager.js";
import { LoggerService } from "../services/LoggerService.js";
import { GameplayContextResolver } from "../socket/GameplayContextResolver.js";
import { RoomLobbyBridge } from "../socket/RoomLobbyBridge.js";
import { SetupSessionLifecycle } from "../gameplay/SetupSessionLifecycle.js";
import { SETUP_SESSION_STATUS } from "../models/SetupSessionStatus.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

function buildStack({ setupDurationMs = 10 * 60 * 1000 } = {}) {

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
        roomConfig: { setupDurationMs }
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

function bindPlayer(stack, { socketId, playerId, roomId }) {

    stack.roomLobbyBridge._registerSocketPlayer(socketId, playerId);

    stack.roomLobbyBridge._attachSocketToRoom(socketId, roomId);

    stack.playerManager.setConnectionState(playerId, CONNECTION_STATE.CONNECTED);

    return stack.roomLobbyBridge.issueRecoveryCredential(playerId, roomId);

}

// Scenario A/B — soft disconnect during ACTIVE Setup Session, reclaim on new socket.
{

    const stack = buildStack();

    try {

        const room = stack.roomManager.createRoom();

        const player = stack.playerManager.createPlayer({ nickname: "Host" });

        const playerId = player.identity.playerId;

        stack.roomManager.addPlayer(room.roomId, playerId);

        stack.playerManager.updateRuntime(playerId, { roomId: room.roomId });

        const recoveryCredential = bindPlayer(stack, {
            socketId: "socket-wifi",
            playerId,
            roomId: room.roomId
        });

        assert(
            stack.setupSessionLifecycle.isRecoverable(room.roomId),
            "protection must begin at SETUP_SESSION_STARTED"
        );

        assert(
            !stack.roomLobbyBridge._startedRooms.has(room.roomId),
            "ACTIVE lobby must not require SETUP_SESSION_COMPLETED"
        );

        const expiresBefore = stack.setupSessionLifecycle
            .getSession(room.roomId).expiresAt;

        stack.roomLobbyBridge._handleSocketDisconnected("socket-wifi");

        assert(
            stack.playerManager.hasPlayer(playerId),
            "soft disconnect must not destroy player entity"
        );

        assert(
            stack.playerManager.getRuntime(playerId).connectionState
                === CONNECTION_STATE.DISCONNECTED,
            "player must become DISCONNECTED only"
        );

        assert(
            stack.roomManager.getRoom(room.roomId)?.players.includes(playerId),
            "soft disconnect must reserve the player slot"
        );

        assert(
            stack.setupSessionLifecycle.getSession(room.roomId)?.state
                === SETUP_SESSION_STATUS.ACTIVE,
            "Setup Session must remain ACTIVE"
        );

        const reconnected = stack.roomLobbyBridge.reconnectGameplaySession(
            "socket-lte",
            { playerId, roomId: room.roomId, recoveryCredential }
        );

        assert(reconnected.ok, "new socket.id reclaim must succeed");

        assert(
            reconnected.setupActive === true,
            "ACTIVE setup reclaim must report setupActive"
        );

        assert(
            stack.setupSessionLifecycle.getSession(room.roomId).expiresAt
                === expiresBefore,
            "Setup Timer must not reset or extend"
        );

        assert(
            stack.roomLobbyBridge._playerToSocket.get(playerId) === "socket-lte",
            "socket binding must update to the new socket"
        );

        console.log("  scenario A/B (ACTIVE setup reclaim) passed");

    } finally {

        stack.shutdown();

    }

}

// Scenario E — recovery rejected after Setup Timer expiry.
{

    const stack = buildStack({ setupDurationMs: 30 });

    try {

        const room = stack.roomManager.createRoom();

        const player = stack.playerManager.createPlayer({ nickname: "Late" });

        const playerId = player.identity.playerId;

        const roomId = room.roomId;

        stack.roomManager.addPlayer(roomId, playerId);

        stack.playerManager.updateRuntime(playerId, { roomId });

        const recoveryCredential = bindPlayer(stack, { socketId: "socket-late", playerId, roomId });

        stack.roomLobbyBridge._handleSocketDisconnected("socket-late");

        // Force expiry path.
        stack.setupSessionLifecycle._onExpiry(roomId);

        assert(
            !stack.setupSessionLifecycle.isRecoverable(roomId),
            "expired setup must not be recoverable"
        );

        const rejected = stack.roomLobbyBridge.reconnectGameplaySession(
            "socket-too-late",
            { playerId, roomId, recoveryCredential }
        );

        assert(!rejected.ok, "recovery after expiry must be rejected");

        console.log("  scenario E (expired setup rejected) passed");

    } finally {

        stack.shutdown();

    }

}

// Locked room remains non-joinable; reclaim is not join.
{

    const stack = buildStack();

    try {

        const room = stack.roomManager.createRoom();

        const players = [];

        const credentials = new Map();

        for (let index = 0; index < room.maxPlayers; index += 1) {

            const player = stack.playerManager.createPlayer({
                nickname: `P${index}`
            });

            players.push(player.identity.playerId);

            stack.roomManager.addPlayer(room.roomId, player.identity.playerId);

            stack.playerManager.updateRuntime(player.identity.playerId, {
                roomId: room.roomId
            });

            credentials.set(
                player.identity.playerId,
                bindPlayer(stack, {
                    socketId: `socket-${index}`,
                    playerId: player.identity.playerId,
                    roomId: room.roomId
                })
            );

        }

        stack.roomManager.lockRoom(room.roomId);

        const seat = players[0];

        stack.roomLobbyBridge._handleSocketDisconnected("socket-0");

        const joined = stack.roomManager.addPlayer(room.roomId, "intruder");

        assert(!joined, "LOCKED room must reject join while seat is reserved");

        const reclaimed = stack.roomLobbyBridge.reconnectGameplaySession(
            "socket-0-new",
            {
                playerId: seat,
                roomId: room.roomId,
                recoveryCredential: credentials.get(seat)
            }
        );

        assert(reclaimed.ok, "original disconnected player may reclaim");

        console.log("  scenario locked-room reclaim (not join) passed");

    } finally {

        stack.shutdown();

    }

}

// Scenario F — reclaim when disconnect event was missed (stale binding).
{

    const stack = buildStack();

    try {

        const room = stack.roomManager.createRoom();

        const player = stack.playerManager.createPlayer({ nickname: "Stale" });

        const playerId = player.identity.playerId;

        const roomId = room.roomId;

        stack.roomManager.addPlayer(roomId, playerId);

        stack.playerManager.updateRuntime(playerId, { roomId });

        const recoveryCredential = bindPlayer(stack, { socketId: "socket-stale", playerId, roomId });

        // R7.5A — reclaim while old binding still present must atomically commit.
        const withoutPrep = stack.roomLobbyBridge.reconnectGameplaySession(
            "socket-new",
            { playerId, roomId, recoveryCredential }
        );

        assert(
            withoutPrep.ok,
            "reclaim with live-old binding must succeed via atomic commit"
        );

        assert(
            stack.roomLobbyBridge._playerToSocket.get(playerId) === "socket-new",
            "socket binding must update to the new socket"
        );

        assert(
            !stack.roomLobbyBridge._socketToPlayer.has("socket-stale"),
            "old socket must be retired after commit"
        );

        console.log("  scenario F (missed disconnect / live transfer) passed");

    } finally {

        stack.shutdown();

    }

}

console.log("setupSession.reconnect.test.js: all assertions passed");
