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
import { SocketGateway } from "../socket/SocketGateway.js";
import { LOBBY_SERVER_EVENTS } from "../socket/lobbyProtocol.js";
import { SetupSessionLifecycle } from "../gameplay/SetupSessionLifecycle.js";
import { SETUP_SESSION_STATUS } from "../models/SetupSessionStatus.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

// Scenario G — an authoritative Page5 start wins over the still-live setup
// timer, and authenticated recovery does not replay stale setup/payment events.
{

    const stack = buildStack();

    try {

        const room = stack.roomManager.createRoom();

        const player = stack.playerManager.createPlayer({ nickname: "Gameplay" });

        const playerId = player.identity.playerId;

        const roomId = room.roomId;

        const gameId = "game-reconnect-page5";

        room.gameMode = "NO_FRIENDS";

        stack.roomManager.addPlayer(roomId, playerId);

        stack.playerManager.updateRuntime(playerId, { roomId, gameId });

        const recoveryCredential = bindPlayer(stack, {
            socketId: "socket-page5-old",
            playerId,
            roomId
        });

        let page6IsActive = false;

        let cachedRecoveryEntry = null;

        const resultSessionLifecycle = {
            isActive: () => page6IsActive,
            getSession: () => page6IsActive
                ? { roomId, gameId, expiresAt: Date.now() + 30_000 }
                : null
        };

        stack.roomLobbyBridge._resultSessionLifecycle = resultSessionLifecycle;

        stack.roomLobbyBridge._recoverySnapshotCache = {
            get: () => cachedRecoveryEntry
        };

        stack.gameplayContextResolver.activateRoomGame(roomId, gameId);

        stack.roomLobbyBridge._gameStartAuthorization = {
            getReconnectSnapshot: () => ({
                roomId,
                gameId,
                phase: "OPEN_PAGE5",
                authorizedAt: 100,
                initializingAt: 200,
                openPage5At: 300
            })
        };

        stack.roomLobbyBridge._handleSocketDisconnected("socket-page5-old");

        stack.roomLobbyBridge._continueToVerifyByRoom.set(roomId, true);

        stack.roomLobbyBridge._verifyBarrierCompletedByRoom.add(roomId);

        stack.roomLobbyBridge._profilesRevealedByRoom.add(roomId);

        const delivered = [];

        stack.roomLobbyBridge._deliverToSocket = (socketId, eventName, payload) => {

            delivered.push({ socketId, eventName, payload });

        };

        stack.roomLobbyBridge._deliverSecretMatrixStatus = () => {};

        const socketId = "socket-page5-new";

        const socket = { id: socketId, connected: true, emit: (channel, message) => {

            delivered.push({ channel, message });

        } };

        const snapshot = {
            gameId,
            gameState: { currentState: "SPEED" },
            configuration: { roomId, sectors: [] },
            physics: {},
            input: { players: [] },
            clock: {}
        };

        const socketGateway = new SocketGateway({
            logger: stack.logger,
            socketConfig: {},
            eventBus: stack.eventBus,
            gameplayContextResolver: stack.gameplayContextResolver,
            roomLobbyBridge: stack.roomLobbyBridge,
            recoverySnapshotCache: { get: () => cachedRecoveryEntry },
            resultSessionLifecycle,
            recoveryEngine: {
                getDebugSnapshot: () => ({ currentState: "SPEED" }),
                recoverPlayer: () => snapshot
            },
            devMode: false
        });

        socketGateway._handleRecoveryRequest(socket, {
            payload: { playerId, roomId, recoveryCredential }
        });

        assert(
            !delivered.some((event) => event.eventName === LOBBY_SERVER_EVENTS.SETUP_SESSION_SYNC),
            "Page5 reconnect must not send SETUP_SESSION_SYNC"
        );

        assert(
            !delivered.some((event) => event.eventName === LOBBY_SERVER_EVENTS.PAYMENT_STAGE_READY),
            "NO_FRIENDS Page5 reconnect must not send PAYMENT_STAGE_READY"
        );

        assert(
            !delivered.some((event) => event.eventName === LOBBY_SERVER_EVENTS.VERIFY_COMPLETED),
            "Page5 reconnect must not replay Page4 verification navigation"
        );

        const opened = delivered.find(
            (event) => event.eventName === LOBBY_SERVER_EVENTS.OPEN_PAGE5
        );

        assert(opened, "Page5 reconnect must replay authoritative OPEN_PAGE5");

        assert(
            opened.payload.roomId === roomId
                && !Object.hasOwn(opened.payload, "gameId"),
            "OPEN_PAGE5 must preserve the production { roomId } contract"
        );

        const authorized = delivered.find(
            (event) => event.eventName === LOBBY_SERVER_EVENTS.GAME_START_AUTHORIZED
        );

        assert(
            authorized?.payload.gameId === gameId,
            "GAME_START_AUTHORIZED must carry the authoritative gameId"
        );

        const recoverySnapshot = delivered.find(
            (event) => event.message?.type === "SESSION_SNAPSHOT"
        );

        assert(
            recoverySnapshot?.message?.payload?.gameState === "SPEED",
            "recovery handler must return the live gameplay snapshot, not SETUP"
        );

        assert(
            stack.setupSessionLifecycle.isRecoverable(roomId),
            "test precondition: the setup timer remains live after Page5 opens"
        );

        // The cached OPEN_PAGE6 marker remains authoritative even when the
        // result-session timer is no longer active. Reconnect must not navigate
        // the client back to Page5.

        snapshot.gameState.currentState = "RESULT";

        cachedRecoveryEntry = {
            snapshot,
            page6Opened: true,
            resultSessionExpiresAt: Date.now() + 30_000
        };

        delivered.length = 0;

        socketGateway._handleRecoveryRequest(socket, { payload: {} });

        assert(
            !delivered.some((event) => event.eventName === LOBBY_SERVER_EVENTS.OPEN_PAGE5),
            "authoritative Page6 recovery must not replay OPEN_PAGE5"
        );

        const page6Snapshot = delivered.find(
            (event) => event.message?.type === "SESSION_SNAPSHOT"
        );

        assert(
            page6Snapshot?.message?.payload?.gameState === "RESULT"
                && page6Snapshot.message.payload.openPage6 === true,
            "Page6 reconnect must receive the authoritative result snapshot"
        );

        console.log("  scenario G (Page5 and Page6 authoritative recovery) passed");

    } finally {

        stack.shutdown();

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
