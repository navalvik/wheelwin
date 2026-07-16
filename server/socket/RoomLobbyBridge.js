import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import {
    isValidRoomId,
    normalizeRoomId
} from "../managers/room/roomIdAlphabet.js";
import { CONNECTION_STATE } from "../models/ConnectionState.js";
import { PLAYER_STATE } from "../models/PlayerState.js";
import { ROOM_STATUS } from "../models/RoomStatus.js";
import {
    LOBBY_ERROR_CODES,
    LOBBY_ERROR_MESSAGES,
    LOBBY_SERVER_EVENTS
} from "./lobbyProtocol.js";

export class RoomLobbyBridge {

    constructor({
        logger,
        eventBus,
        roomManager,
        playerManager,
        gameplayContextResolver = null,
        setupSessionLifecycle = null
    }) {

        this._logger = logger;

        this._eventBus = eventBus;

        this._roomManager = roomManager;

        this._playerManager = playerManager;

        this._gameplayContextResolver = gameplayContextResolver;

        this._setupSessionLifecycle = setupSessionLifecycle;

        this._socketToPlayer = new Map();

        this._playerToSocket = new Map();

        this._roomCreators = new Map();

        // Server-owned recovery identity keyed by socket id (stashed on soft disconnect).
        this._recoveryOwnershipBySocket = new Map();

        // Rooms whose Game Session has started (post Setup Session completion).
        this._startedRooms = new Set();

        this._handlers = [];

        this._initialized = false;

    }

    initialize() {

        this._subscribe(
            EVENT_TYPES.LOBBY_CREATE_ROOM_REQUEST,
            (envelope) => {

                this._handleCreateRoom(envelope.payload.socketId);

            }
        );

        this._subscribe(
            EVENT_TYPES.LOBBY_JOIN_ROOM_REQUEST,
            (envelope) => {

                this._handleJoinRoom(
                    envelope.payload.socketId,
                    envelope.payload.roomId
                );

            }
        );

        this._subscribe(
            EVENT_TYPES.LOBBY_LEAVE_ROOM_REQUEST,
            (envelope) => {

                this._handleLeaveRoom(envelope.payload.socketId);

            }
        );

        this._subscribe(
            EVENT_TYPES.LOBBY_SOCKET_DISCONNECTED,
            (envelope) => {

                this._handleSocketDisconnected(envelope.payload.socketId);

            }
        );

        this._subscribe(
            EVENT_TYPES.ROOM_FULL,
            (envelope) => {

                this._handleRoomFull(envelope.payload.roomId);

            }
        );

        this._subscribe(
            EVENT_TYPES.SETUP_SESSION_STARTED,
            (envelope) => {

                this._handleSetupSessionStarted(envelope.payload);

            }
        );

        this._subscribe(
            EVENT_TYPES.SETUP_SESSION_EXPIRED,
            (envelope) => {

                this._handleSetupSessionExpired(envelope.payload);

            }
        );

        this._subscribe(
            EVENT_TYPES.SETUP_SESSION_COMPLETED,
            (envelope) => {

                this._handleSetupSessionCompleted(envelope.payload);

            }
        );

        this._subscribe(
            EVENT_TYPES.GAME_INITIALIZED,
            (envelope) => {

                this._handleGameInitialized(envelope.payload);

            }
        );

        this._initialized = true;

    }

    shutdown() {

        for (const subscription of this._handlers) {

            this._eventBus.unsubscribe(
                subscription.event,
                subscription.handler
            );

        }

        this._handlers = [];

        this._socketToPlayer.clear();

        this._playerToSocket.clear();

        this._roomCreators.clear();

        this._startedRooms.clear();

        this._initialized = false;

    }

    _syncGameplaySocketBinding(socketId, roomId) {

        if (!this._gameplayContextResolver) {

            return;

        }

        const playerId = this._socketToPlayer.get(socketId);

        if (!playerId || !roomId) {

            return;

        }

        this._gameplayContextResolver.bindSocket(socketId, {
            playerId,
            roomId
        });

    }

    _handleCreateRoom(socketId) {

        if (this._socketToPlayer.has(socketId)) {

            this._emitRoomError(
                socketId,
                LOBBY_ERROR_CODES.PLAYER_ALREADY_CONNECTED
            );

            return;

        }

        if (this._roomManager.isAtCapacity()) {

            this._emitRoomError(
                socketId,
                LOBBY_ERROR_CODES.ROOM_CREATION_LIMIT
            );

            return;

        }

        const room = this._roomManager.createRoom();

        if (!room) {

            this._emitRoomError(
                socketId,
                this._roomManager.isAtCapacity()
                    ? LOBBY_ERROR_CODES.ROOM_CREATION_LIMIT
                    : LOBBY_ERROR_CODES.UNKNOWN_ERROR
            );

            return;

        }

        const player = this._playerManager.createPlayer();

        if (!player) {

            this._roomManager.destroyRoom(room.roomId);

            this._emitRoomError(socketId, LOBBY_ERROR_CODES.UNKNOWN_ERROR);

            return;

        }

        const playerId = player.identity.playerId;

        this._registerSocketPlayer(socketId, playerId);

        this._playerManager.setConnectionState(
            playerId,
            CONNECTION_STATE.CONNECTED
        );

        this._playerManager.setPlayerState(playerId, PLAYER_STATE.IN_ROOM);

        this._attachSocketToRoom(socketId, room.roomId);

        if (!this._roomManager.addPlayer(room.roomId, playerId)) {

            this._cleanupPlayer(playerId);

            this._unregisterSocket(socketId);

            this._roomManager.destroyRoom(room.roomId);

            this._emitRoomError(socketId, LOBBY_ERROR_CODES.UNKNOWN_ERROR);

            return;

        }

        this._playerManager.updateRuntime(playerId, {
            roomId: room.roomId
        });

        this._roomCreators.set(room.roomId, playerId);

        this._logger.info(
            `Lobby room created | roomId=${room.roomId} | playerId=${playerId}`
        );

        this._emitPlayerJoined(room.roomId, playerId);

        const roomSnapshot = this._roomManager.getRoom(room.roomId);

        const roomCreatedPayload = {
            roomId: roomSnapshot.roomId,
            playerId,
            connectedPlayers: roomSnapshot.players.length,
            maxPlayers: roomSnapshot.maxPlayers,
            players: this._buildPlayerList(roomSnapshot)
        };

        this._deliverToSocket(
            socketId,
            LOBBY_SERVER_EVENTS.ROOM_CREATED,
            roomCreatedPayload
        );

        this._broadcastRoomState(room.roomId);

        this._deliverSetupSessionSync(room.roomId, socketId);

    }

    _handleJoinRoom(socketId, rawRoomId) {

        if (this._socketToPlayer.has(socketId)) {

            this._emitRoomError(
                socketId,
                LOBBY_ERROR_CODES.PLAYER_ALREADY_CONNECTED
            );

            return;

        }

        const roomId = this._resolveRoomId(rawRoomId);

        if (!roomId) {

            this._emitRoomError(
                socketId,
                this._isInvalidRoomId(rawRoomId)
                    ? LOBBY_ERROR_CODES.INVALID_ROOM_ID
                    : LOBBY_ERROR_CODES.ROOM_NOT_FOUND
            );

            return;

        }

        const room = this._roomManager.getRoom(roomId);

        if (!room) {

            this._emitRoomError(socketId, LOBBY_ERROR_CODES.ROOM_NOT_FOUND);

            return;

        }

        if (room.status === ROOM_STATUS.LOCKED) {

            this._emitRoomError(socketId, LOBBY_ERROR_CODES.ROOM_LOCKED);

            return;

        }

        if (room.status === ROOM_STATUS.FULL
            || room.players.length >= room.maxPlayers) {

            this._emitRoomError(socketId, LOBBY_ERROR_CODES.ROOM_FULL);

            return;

        }

        const player = this._playerManager.createPlayer();

        if (!player) {

            this._emitRoomError(socketId, LOBBY_ERROR_CODES.UNKNOWN_ERROR);

            return;

        }

        const playerId = player.identity.playerId;

        this._registerSocketPlayer(socketId, playerId);

        this._playerManager.setConnectionState(
            playerId,
            CONNECTION_STATE.CONNECTED
        );

        this._playerManager.setPlayerState(playerId, PLAYER_STATE.IN_ROOM);

        this._attachSocketToRoom(socketId, roomId);

        if (!this._roomManager.addPlayer(roomId, playerId)) {

            this._cleanupPlayer(playerId);

            this._unregisterSocket(socketId);

            const latestRoom = this._roomManager.getRoom(roomId);

            if (!latestRoom) {

                this._emitRoomError(socketId, LOBBY_ERROR_CODES.ROOM_NOT_FOUND);

            } else if (latestRoom.status === ROOM_STATUS.LOCKED) {

                this._emitRoomError(socketId, LOBBY_ERROR_CODES.ROOM_LOCKED);

            } else {

                this._emitRoomError(socketId, LOBBY_ERROR_CODES.ROOM_FULL);

            }

            return;

        }

        this._playerManager.updateRuntime(playerId, {
            roomId
        });

        this._logger.info(
            `Lobby room joined | roomId=${roomId} | playerId=${playerId}`
        );

        this._emitPlayerJoined(roomId, playerId);

        const roomSnapshot = this._roomManager.getRoom(roomId);

        this._deliverToSocket(
            socketId,
            LOBBY_SERVER_EVENTS.ROOM_JOINED,
            {
                roomId: roomSnapshot.roomId,
                playerId,
                connectedPlayers: roomSnapshot.players.length,
                maxPlayers: roomSnapshot.maxPlayers,
                players: this._buildPlayerList(roomSnapshot)
            }
        );

        this._broadcastRoomState(roomId);

        this._deliverSetupSessionSync(roomId, socketId);

    }

    _handleLeaveRoom(socketId) {

        const context = this._getSocketContext(socketId);

        if (!context) {

            return;

        }

        this._removePlayerFromLobby(
            context.playerId,
            context.roomId,
            {
                notifyPlayer: true,
                reason: "left"
            }
        );

    }

    _handleSocketDisconnected(socketId) {

        const context = this._getSocketContext(socketId);

        if (!context) {

            return;

        }

        if (this._isProtectedSession(context.roomId)) {

            this._stashRecoveryOwnership(socketId, {
                playerId: context.playerId,
                roomId: context.roomId
            });

            this._playerManager.setConnectionState(
                context.playerId,
                CONNECTION_STATE.DISCONNECTED
            );

            this._unregisterSocket(socketId);

            this._logger.info(
                `Lobby soft disconnect | roomId=${context.roomId} | playerId=${context.playerId}`
            );

            return;

        }

        this._removePlayerFromLobby(
            context.playerId,
            context.roomId,
            {
                notifyPlayer: false,
                reason: "disconnect"
            }
        );

    }

    /**
     * Resolve the server-owned recovery identity for a reconnecting socket.
     * Never reads client-supplied playerId or roomId.
     */
    resolveRecoveryIdentity(socketId) {

        if (!socketId) {

            return null;

        }

        const activeContext = this._getSocketContext(socketId);

        if (activeContext) {

            return {
                playerId: activeContext.playerId,
                roomId: activeContext.roomId
            };

        }

        const stashed = this._recoveryOwnershipBySocket.get(socketId);

        if (!stashed) {

            return null;

        }

        if (!this._isRecoverableIdentity(stashed.playerId, stashed.roomId)) {

            this._recoveryOwnershipBySocket.delete(socketId);

            return null;

        }

        return stashed;

    }

    /**
     * Rebind a socket for Setup Session or Game Session recovery.
     * Identity is resolved exclusively from server-owned socket ownership.
     * Setup reconnect never restarts the timer / session.
     */
    reconnectSession(socketId) {

        const identity = this.resolveRecoveryIdentity(socketId);

        if (!identity) {

            return {
                ok: false,
                reason: "Recovery identity is not authorized for this socket"
            };

        }

        const { playerId, roomId } = identity;

        const room = this._roomManager.getRoom(roomId);

        if (!room) {

            return {
                ok: false,
                reason: "Room session is not active"
            };

        }

        if (!this._isRecoverableIdentity(playerId, roomId)) {

            return {
                ok: false,
                reason: "Player session is not recoverable"
            };

        }

        this._registerSocketPlayer(socketId, playerId);

        this._playerManager.setConnectionState(
            playerId,
            CONNECTION_STATE.CONNECTED
        );

        this._attachSocketToRoom(socketId, roomId);

        const runtime = this._playerManager.getRuntime(playerId);

        const gameId = this._gameplayContextResolver
            ?.resolve(socketId)?.gameId
            ?? runtime?.gameId
            ?? null;

        const setupActive = this._setupSessionLifecycle?.isActive(roomId) === true;

        if (setupActive) {

            const syncPayload = this._setupSessionLifecycle.buildSyncPayload(roomId);

            if (syncPayload) {

                this._deliverToSocket(
                    socketId,
                    LOBBY_SERVER_EVENTS.SETUP_SESSION_SYNC,
                    syncPayload
                );

                this._eventBus.emit({
                    source: EVENT_SOURCES.ROOM_LOBBY_BRIDGE,
                    type: EVENT_TYPES.SETUP_SESSION_SYNC,
                    payload: syncPayload
                });

            }

        }

        this._clearRecoveryOwnership(socketId);

        this._logger.info(
            `Lobby recovery reconnect | roomId=${roomId} | playerId=${playerId}`
        );

        return {
            ok: true,
            playerId,
            roomId,
            gameId,
            setupActive
        };

    }

    reconnectGameplaySession(socketId) {

        return this.reconnectSession(socketId);

    }

    /**
     * Moves stashed recovery ownership to a new socket id.
     * Used only by integration tests that simulate a page refresh with a new socket.
     */
    transferRecoveryOwnership(fromSocketId, toSocketId) {

        const identity = this._recoveryOwnershipBySocket.get(fromSocketId);

        if (!identity || !toSocketId) {

            return false;

        }

        this._recoveryOwnershipBySocket.delete(fromSocketId);

        this._recoveryOwnershipBySocket.set(toSocketId, identity);

        return true;

    }

    _handleRoomFull(roomId) {

        if (!roomId) {

            return;

        }

        const room = this._roomManager.getRoom(roomId);

        if (!room) {

            return;

        }

        // Capacity lock only — Game Session starts after Setup Session completes.
        this._roomManager.lockRoom(roomId);

        this._logger.info(`Lobby room full | roomId=${roomId}`);

    }

    _handleSetupSessionStarted(payload) {

        if (!payload?.roomId) {

            return;

        }

        this._deliverToRoom(
            payload.roomId,
            LOBBY_SERVER_EVENTS.SETUP_SESSION_STARTED,
            payload
        );

    }

    _handleSetupSessionCompleted(payload) {

        const roomId = payload?.roomId;

        if (!roomId || this._startedRooms.has(roomId)) {

            return;

        }

        this._startedRooms.add(roomId);

        this._logger.info(`Lobby game ready | roomId=${roomId}`);

    }

    _handleSetupSessionExpired(payload) {

        const roomId = payload?.roomId;

        if (!roomId) {

            return;

        }

        this._deliverToRoom(
            roomId,
            LOBBY_SERVER_EVENTS.SETUP_SESSION_EXPIRED,
            payload
        );

        // RoomManager.destroyRoom is invoked by SetupSessionLifecycle after
        // EXPIRED. When the room is already gone, only clean lobby maps.
        if (!this._roomManager.getRoom(roomId)) {

            this._roomCreators.delete(roomId);

            this._startedRooms.delete(roomId);

            this._gameplayContextResolver?.deactivateRoomGame(roomId);

            return;

        }

        this._closeRoom(roomId, "setup_expired");

    }

    _handleGameInitialized({ gameId, roomId }) {

        if (!gameId || !roomId) {

            return;

        }

        const room = this._roomManager.getRoom(roomId);

        if (!room) {

            return;

        }

        for (const playerId of room.players) {

            this._playerManager.updateRuntime(playerId, {
                gameId
            });

        }

        this._gameplayContextResolver?.activateRoomGame(roomId, gameId);

        const players = this._buildPlayerList(room);

        const startGamePayload = {
            roomId,
            gameId,
            players
        };

        for (const playerId of room.players) {

            const socketId = this._playerToSocket.get(playerId);

            if (!socketId) {

                continue;

            }

            this._deliverToSocket(
                socketId,
                LOBBY_SERVER_EVENTS.START_GAME,
                startGamePayload
            );

        }

    }

    _removePlayerFromLobby(playerId, roomId, { notifyPlayer, reason }) {

        this._clearRecoveryOwnershipForPlayer(playerId);

        const socketId = this._playerToSocket.get(playerId);

        const creatorId = this._roomCreators.get(roomId);

        const gameStarted = this._startedRooms.has(roomId);

        if (creatorId === playerId && !gameStarted) {

            this._closeRoom(roomId, "creator_left");

            return;

        }

        // C4.9 — Deliberate leave of a started room ends the session. Only an
        // explicit "return to Page1" leave reaches this path for a started room:
        // socket disconnects soft-detach and return earlier for reconnect. Close
        // the whole session so no gameplay-owned lobby state (room, room->game
        // mapping, started flag, players/sockets) survives the completed game.
        // Recovery (disconnect/reconnect) is untouched — it never gets here.
        if (gameStarted) {

            this._closeRoom(roomId, "session_ended");

            return;

        }

        const room = this._roomManager.getRoom(roomId);

        if (!room) {

            this._cleanupPlayer(playerId);

            if (socketId) {

                this._unregisterSocket(socketId);

            }

            return;

        }

        if (room.status !== ROOM_STATUS.LOCKED) {

            this._roomManager.removePlayer(roomId, playerId);

        }

        this._emitPlayerLeft(roomId, playerId);

        this._cleanupPlayer(playerId);

        if (socketId) {

            if (notifyPlayer) {

                this._deliverToSocket(
                    socketId,
                    LOBBY_SERVER_EVENTS.ROOM_LEFT,
                    { roomId, playerId }
                );

            }

            this._unregisterSocket(socketId);

        }

        this._logger.info(
            `Lobby room left | roomId=${roomId} | playerId=${playerId} | reason=${reason}`
        );

        const remainingRoom = this._roomManager.getRoom(roomId);

        if (!remainingRoom || remainingRoom.players.length === 0) {

            this._roomManager.destroyRoom(roomId);

            this._roomCreators.delete(roomId);

            return;

        }

        this._broadcastRoomState(roomId);

    }

    _closeRoom(roomId, reason) {

        const room = this._roomManager.getRoom(roomId);

        if (!room) {

            return;

        }

        const playerIds = [...room.players];

        this._roomManager.destroyRoom(roomId);

        this._roomCreators.delete(roomId);

        this._startedRooms.delete(roomId);

        this._gameplayContextResolver?.deactivateRoomGame(roomId);

        this._logger.info(`Lobby room closed | roomId=${roomId} | reason=${reason}`);

        this._deliverToRoom(
            roomId,
            LOBBY_SERVER_EVENTS.ROOM_CLOSED,
            {
                roomId,
                reason
            }
        );

        for (const playerId of playerIds) {

            const socketId = this._playerToSocket.get(playerId);

            this._cleanupPlayer(playerId);

            if (socketId) {

                this._unregisterSocket(socketId);

            }

        }

    }

    _broadcastRoomState(roomId) {

        const room = this._roomManager.getRoom(roomId);

        if (!room) {

            return;

        }

        this._deliverToRoom(
            roomId,
            LOBBY_SERVER_EVENTS.ROOM_STATE,
            this._buildRoomState(room)
        );

    }

    _buildRoomState(room) {

        return {
            roomId: room.roomId,
            connectedPlayers: room.players.length,
            maxPlayers: room.maxPlayers,
            players: this._buildPlayerList(room),
            state: room.status
        };

    }

    _buildPlayerList(room) {

        return room.players.map((playerId) => {

            const identity = this._playerManager.getIdentity(playerId);

            return {
                playerId,
                nickname: identity?.nickname ?? null
            };

        });

    }

    _resolveRoomId(rawRoomId) {

        const normalized = normalizeRoomId(rawRoomId);

        if (!normalized) {

            return null;

        }

        if (!isValidRoomId(normalized)) {

            return null;

        }

        if (this._roomManager.hasRoom(normalized)) {

            return normalized;

        }

        return null;

    }

    _isInvalidRoomId(rawRoomId) {

        const normalized = normalizeRoomId(rawRoomId);

        if (!normalized) {

            return true;

        }

        return !isValidRoomId(normalized);

    }

    _getSocketContext(socketId) {

        const playerId = this._socketToPlayer.get(socketId);

        if (!playerId) {

            return null;

        }

        const runtime = this._playerManager.getRuntime(playerId);

        if (!runtime?.roomId) {

            return null;

        }

        return {
            socketId,
            playerId,
            roomId: runtime.roomId
        };

    }

    _registerSocketPlayer(socketId, playerId) {

        if (!socketId || !playerId) {

            return;

        }

        const existingSocketForPlayer = this._playerToSocket.get(playerId);

        if (existingSocketForPlayer && existingSocketForPlayer !== socketId) {

            this._unregisterSocket(existingSocketForPlayer);

        }

        const existingPlayerForSocket = this._socketToPlayer.get(socketId);

        if (existingPlayerForSocket && existingPlayerForSocket !== playerId) {

            this._unregisterSocket(socketId);

        }

        this._socketToPlayer.set(socketId, playerId);

        this._playerToSocket.set(playerId, socketId);

    }

    _attachSocketToRoom(socketId, roomId) {

        this._deliverSocketJoinRoom(socketId, roomId);

        this._syncGameplaySocketBinding(socketId, roomId);

    }

    _unregisterSocket(socketId) {

        const playerId = this._socketToPlayer.get(socketId);

        this._socketToPlayer.delete(socketId);

        this._gameplayContextResolver?.unbindSocket(socketId);

        if (playerId) {

            this._playerToSocket.delete(playerId);

        }

        this._deliverSocketLeaveRoom(socketId);

    }

    _cleanupPlayer(playerId) {

        this._clearRecoveryOwnershipForPlayer(playerId);

        this._playerManager.setConnectionState(
            playerId,
            CONNECTION_STATE.DISCONNECTED
        );

        this._playerManager.removePlayer(playerId);

    }

    _emitRoomError(socketId, code) {

        this._deliverToSocket(
            socketId,
            LOBBY_SERVER_EVENTS.ROOM_ERROR,
            {
                code,
                message: LOBBY_ERROR_MESSAGES[code]
                    ?? LOBBY_ERROR_MESSAGES[LOBBY_ERROR_CODES.UNKNOWN_ERROR]
            }
        );

    }

    _emitPlayerJoined(roomId, playerId) {

        const room = this._roomManager.getRoom(roomId);

        this._eventBus.emit({
            source: EVENT_SOURCES.ROOM_LOBBY_BRIDGE,
            type: EVENT_TYPES.PLAYER_JOINED,
            payload: {
                roomId,
                playerId,
                playerCount: room?.players.length ?? 0
            }
        });

    }

    _emitPlayerLeft(roomId, playerId) {

        const room = this._roomManager.getRoom(roomId);

        this._eventBus.emit({
            source: EVENT_SOURCES.ROOM_LOBBY_BRIDGE,
            type: EVENT_TYPES.PLAYER_LEFT,
            payload: {
                roomId,
                playerId,
                playerCount: room?.players.length ?? 0
            }
        });

    }

    _deliverSetupSessionSync(roomId, socketId) {

        const syncPayload = this._setupSessionLifecycle?.buildSyncPayload(roomId);

        if (!syncPayload) {

            return;

        }

        this._deliverToSocket(
            socketId,
            LOBBY_SERVER_EVENTS.SETUP_SESSION_SYNC,
            syncPayload
        );

    }

    /**
     * Soft disconnect / reconnect while Game Session has started (post Setup
     * Session completion). Waiting lobby membership still uses hard leave so
     * creator disconnect can close an unfilled room.
     *
     * Setup Session SYNC is delivered on reconnectSession when the session is
     * still ACTIVE (e.g. capacity lock race); RecoveryEngine stays gameplay-only.
     */
    _isProtectedSession(roomId) {

        return this._startedRooms.has(roomId);

    }

    _isRecoverableIdentity(playerId, roomId) {

        if (!playerId || !roomId) {

            return false;

        }

        const room = this._roomManager.getRoom(roomId);

        if (!room || !room.players.includes(playerId)) {

            return false;

        }

        if (!this._isProtectedSession(roomId)) {

            return false;

        }

        return this._playerManager.hasPlayer(playerId);

    }

    _stashRecoveryOwnership(socketId, { playerId, roomId }) {

        if (!socketId || !playerId || !roomId) {

            return;

        }

        this._recoveryOwnershipBySocket.set(socketId, {
            playerId,
            roomId
        });

    }

    _clearRecoveryOwnership(socketId) {

        if (!socketId) {

            return;

        }

        this._recoveryOwnershipBySocket.delete(socketId);

    }

    _clearRecoveryOwnershipForPlayer(playerId) {

        if (!playerId) {

            return;

        }

        for (const [socketId, identity] of this._recoveryOwnershipBySocket.entries()) {

            if (identity.playerId === playerId) {

                this._recoveryOwnershipBySocket.delete(socketId);

            }

        }

    }

    _deliverToSocket(socketId, event, payload) {

        this._eventBus.emit({
            source: EVENT_SOURCES.ROOM_LOBBY_BRIDGE,
            type: EVENT_TYPES.LOBBY_SOCKET_DELIVERY,
            payload: {
                target: "socket",
                socketId,
                event,
                payload
            }
        });

    }

    _deliverToRoom(roomId, event, payload) {

        this._eventBus.emit({
            source: EVENT_SOURCES.ROOM_LOBBY_BRIDGE,
            type: EVENT_TYPES.LOBBY_SOCKET_DELIVERY,
            payload: {
                target: "room",
                roomId,
                event,
                payload
            }
        });

    }

    _deliverSocketJoinRoom(socketId, roomId) {

        if (!roomId) {

            return;

        }

        this._eventBus.emit({
            source: EVENT_SOURCES.ROOM_LOBBY_BRIDGE,
            type: EVENT_TYPES.LOBBY_SOCKET_DELIVERY,
            payload: {
                target: "join",
                socketId,
                roomId
            }
        });

    }

    _deliverSocketLeaveRoom(socketId) {

        this._eventBus.emit({
            source: EVENT_SOURCES.ROOM_LOBBY_BRIDGE,
            type: EVENT_TYPES.LOBBY_SOCKET_DELIVERY,
            payload: {
                target: "leave",
                socketId
            }
        });

    }

    _subscribe(event, handler) {

        this._eventBus.subscribe(event, handler);

        this._handlers.push({ event, handler });

    }

}
