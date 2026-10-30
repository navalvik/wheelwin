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

// Scenario G — an authenticated Telegram seat is recoverable when room
// assignment succeeded but the browser missed roomCreated/roomJoined and its
// one-time credential. No client room/player claim is supplied.
{

    const stack = buildStack();

    try {

        const telegramBySocket = new Map([
            ["creator-old", "tg-creator"],
            ["guest-old", "tg-guest"]
        ]);
        stack.roomLobbyBridge.configureTelegramIdentityResolver(
            (socketId) => telegramBySocket.get(socketId) ?? null
        );

        const deliveries = [];
        stack.roomLobbyBridge._deliverToSocket = (socketId, eventName, payload) => {
            deliveries.push({ socketId, eventName, payload });
        };

        stack.roomLobbyBridge._handleCreateRoom("creator-old", {
            gameMode: "NO_FRIENDS"
        });

        const created = deliveries.find((entry) =>
            entry.eventName === LOBBY_SERVER_EVENTS.ROOM_CREATED
        );
        assert(created?.payload?.roomId && created?.payload?.playerId,
            "creator seat must be allocated before the initial room event");
        const roomId = created.payload.roomId;
        const creatorPlayerId = created.payload.playerId;

        stack.roomLobbyBridge._handleJoinRoom("guest-old", roomId);
        const joined = deliveries.find((entry) =>
            entry.socketId === "guest-old"
                && entry.eventName === LOBBY_SERVER_EVENTS.ROOM_JOINED
        );
        assert(joined?.payload?.playerId, "guest must receive an assigned seat");
        const guestPlayerId = joined.payload.playerId;

        stack.roomLobbyBridge._handleSocketDisconnected("creator-old");
        telegramBySocket.set("creator-new", "tg-creator");
        const creatorRecovery = stack.roomLobbyBridge.reconnectGameplaySession(
            "creator-new",
            null
        );
        assert(creatorRecovery.ok, "creator can recover from verified Telegram identity");
        assert(creatorRecovery.roomId === roomId
            && creatorRecovery.playerId === creatorPlayerId,
        "creator recovery must reclaim the same room and seat");
        assert(stack.roomManager.getRoom(roomId).players.length === 2,
            "creator recovery must not register a duplicate player");

        const creatorSync = deliveries.find((entry) =>
            entry.socketId === "creator-new"
                && entry.eventName === LOBBY_SERVER_EVENTS.ROOM_RECOVERY_SYNC
        );
        assert(creatorSync?.payload?.stage === "NO_FRIENDS_OPTIONS",
            "matched NO_FRIENDS recovery must restore the options stage");
        assert(creatorSync.payload.recoveryCredential,
            "recovery must privately return a fresh credential after seat commit");
        assert(stack.roomLobbyBridge.authorizeRecoveryCredential({
            playerId: creatorPlayerId,
            roomId,
            credential: creatorSync.payload.recoveryCredential
        }).ok, "recovered credential must authorize the same assigned seat");

        stack.playerManager.updateIdentity(creatorPlayerId, {
            nickname: "ABCD",
            age: 24,
            baseStake: 1,
            wallet: `0:${"a".repeat(64)}`
        });
        stack.roomLobbyBridge._noFriendsOptionsReadyByRoom.set(roomId, new Set());
        const selectedOptions = {
            nickname: "ABCD",
            age: 24,
            baseStake: 1,
            sectorCount: 2,
            sectorArrangement: "separate",
            color: "Red",
            colorSector2: "Blue"
        };
        stack.roomLobbyBridge._handleNoFriendsOptionsNext(
            "creator-new",
            selectedOptions
        );
        stack.roomLobbyBridge._handleNoFriendsOptionsNext(
            "creator-new",
            selectedOptions
        );
        assert(stack.roomLobbyBridge._noFriendsOptionsReadyByRoom.get(roomId).size === 1,
            "repeated options submission must remain idempotent");

        stack.roomLobbyBridge._handleSocketDisconnected("creator-new");
        telegramBySocket.set("creator-refresh", "tg-creator");
        const refreshedRecovery = stack.roomLobbyBridge.reconnectGameplaySession(
            "creator-refresh",
            null
        );
        assert(refreshedRecovery.ok, "options-stage seat must remain recoverable");
        const optionsSync = deliveries.find((entry) =>
            entry.socketId === "creator-refresh"
                && entry.eventName === LOBBY_SERVER_EVENTS.ROOM_RECOVERY_SYNC
        )?.payload;
        assert(optionsSync?.optionsReady === true && optionsSync.readyCount === 1,
            "recovery must restore submitted state and authoritative ready count");
        assert(optionsSync.profile.sectorCount === 2
            && optionsSync.profile.sectorArrangement === "separate"
            && optionsSync.profile.color === "Red"
            && optionsSync.profile.colorSector2 === "Blue",
        "recovery must return the player's accepted options");

        stack.roomLobbyBridge._handleSocketDisconnected("guest-old");
        telegramBySocket.set("guest-new", "tg-guest");
        const guestRecovery = stack.roomLobbyBridge.reconnectGameplaySession(
            "guest-new",
            null
        );
        assert(guestRecovery.ok
            && guestRecovery.roomId === roomId
            && guestRecovery.playerId === guestPlayerId,
        "guest recovery must reclaim the same assigned seat");
        assert(stack.roomManager.getRoom(roomId).players.length === 2,
            "guest recovery must not duplicate room membership");

        telegramBySocket.set("stranger", "tg-stranger");
        const strangerRecovery = stack.roomLobbyBridge.reconnectGameplaySession(
            "stranger",
            null
        );
        assert(!strangerRecovery.ok,
            "an unrelated Telegram account must not recover either seat");
        assert(stack.roomManager.getRoom(roomId).players.length === 2,
            "failed recovery must not create a player or room membership");

        console.log("  scenario G (authenticated assignment/event race) passed");

    } finally {

        stack.shutdown();

    }

}

// Scenario H — FRIENDS recovery uses server stage markers instead of the
// previously displayed browser page as Page2, Matrix and Verify advance.
{

    const stack = buildStack();

    try {

        const telegramBySocket = new Map([
            ["friend-creator", "tg-friend-1"],
            ["friend-guest-2", "tg-friend-2"],
            ["friend-guest-3", "tg-friend-3"]
        ]);
        stack.roomLobbyBridge.configureTelegramIdentityResolver(
            (socketId) => telegramBySocket.get(socketId) ?? null
        );
        const deliveries = [];
        stack.roomLobbyBridge._deliverToSocket = (socketId, eventName, payload) => {
            deliveries.push({ socketId, eventName, payload });
        };

        stack.roomLobbyBridge._handleCreateRoom("friend-creator");
        const created = deliveries.find((entry) =>
            entry.eventName === LOBBY_SERVER_EVENTS.ROOM_CREATED
        ).payload;
        const roomId = created.roomId;
        const creatorPlayerId = created.playerId;
        stack.roomLobbyBridge._handleJoinRoom("friend-guest-2", roomId);
        stack.roomLobbyBridge._handleJoinRoom("friend-guest-3", roomId);

        const room = stack.roomManager.getRoom(roomId);
        for (const [index, playerId] of room.players.entries()) {
            stack.playerManager.updateIdentity(playerId, {
                nickname: `P${index}`,
                age: 24,
                baseStake: 1,
                sectorCount: 1,
                sectorArrangement: "together",
                color: "Red"
            });
        }

        stack.roomLobbyBridge._handleSocketDisconnected("friend-creator");
        telegramBySocket.set("friend-creator-refresh", "tg-friend-1");
        stack.roomLobbyBridge.reconnectGameplaySession("friend-creator-refresh");
        let sync = deliveries.filter((entry) =>
            entry.socketId === "friend-creator-refresh"
                && entry.eventName === LOBBY_SERVER_EVENTS.ROOM_RECOVERY_SYNC
        ).at(-1)?.payload;
        assert(sync?.playerId === creatorPlayerId && sync.stage === "MATRIX",
            `complete Page2 profiles must restore the Matrix stage: ${JSON.stringify(sync)}`);

        stack.roomLobbyBridge._handleSocketDisconnected("friend-creator-refresh");
        stack.roomLobbyBridge._secretMatrixAcceptedByRoom.add(roomId);
        stack.roomLobbyBridge._profilesRevealedByRoom.add(roomId);
        telegramBySocket.set("friend-creator-verify", "tg-friend-1");
        stack.roomLobbyBridge.reconnectGameplaySession("friend-creator-verify");
        sync = deliveries.filter((entry) =>
            entry.socketId === "friend-creator-verify"
                && entry.eventName === LOBBY_SERVER_EVENTS.ROOM_RECOVERY_SYNC
        ).at(-1)?.payload;
        assert(sync?.stage === "VERIFY",
            "accepted Matrix state must advance recovery to Verify");

        stack.roomLobbyBridge._handleSocketDisconnected("friend-creator-verify");
        stack.roomLobbyBridge._verifyBarrierCompletedByRoom.add(roomId);
        telegramBySocket.set("friend-creator-payment", "tg-friend-1");
        stack.roomLobbyBridge.reconnectGameplaySession("friend-creator-payment");
        sync = deliveries.filter((entry) =>
            entry.socketId === "friend-creator-payment"
                && entry.eventName === LOBBY_SERVER_EVENTS.ROOM_RECOVERY_SYNC
        ).at(-1)?.payload;
        assert(sync?.stage === "PAYMENT",
            "completed verify barrier must restore Payment, not a stale setup page");

        console.log("  scenario H (FRIENDS authoritative early stages) passed");

    } finally {

        stack.shutdown();

    }

}

console.log("setupSession.reconnect.test.js: all assertions passed");
