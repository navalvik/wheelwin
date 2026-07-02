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
        gameplayContextResolver = null
    }) {

        this._logger = logger;

        this._eventBus = eventBus;

        this._roomManager = roomManager;

        this._playerManager = playerManager;

        this._gameplayContextResolver = gameplayContextResolver;

        this._socketToPlayer = new Map();

        this._playerToSocket = new Map();

        this._roomCreators = new Map();

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

        const room = this._roomManager.createRoom();

        if (!room) {

            this._emitRoomError(socketId, LOBBY_ERROR_CODES.UNKNOWN_ERROR);

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

        if (this._startedRooms.has(context.roomId)) {

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

    reconnectGameplaySession(socketId, { playerId, roomId }) {

        if (!socketId || !playerId || !roomId) {

            return {
                ok: false,
                reason: "playerId and roomId are required for recovery"
            };

        }

        const room = this._roomManager.getRoom(roomId);

        if (!room) {

            return {
                ok: false,
                reason: "Room session is not active"
            };

        }

        if (!room.players.includes(playerId)) {

            return {
                ok: false,
                reason: "Player is not in the active room"
            };

        }

        if (!this._startedRooms.has(roomId)) {

            return {
                ok: false,
                reason: "Gameplay has not started for this room"
            };

        }

        if (!this._playerManager.hasPlayer(playerId)) {

            return {
                ok: false,
                reason: "Player session no longer exists"
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

        this._logger.info(
            `Lobby recovery reconnect | roomId=${roomId} | playerId=${playerId}`
        );

        return {
            ok: true,
            playerId,
            roomId,
            gameId
        };

    }

    _handleRoomFull(roomId) {

        if (this._startedRooms.has(roomId)) {

            return;

        }

        const room = this._roomManager.getRoom(roomId);

        if (!room) {

            return;

        }

        this._startedRooms.add(roomId);

        this._roomManager.lockRoom(roomId);

        this._logger.info(`Lobby game ready | roomId=${roomId}`);

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

        const socketId = this._playerToSocket.get(playerId);

        const creatorId = this._roomCreators.get(roomId);

        const gameStarted = this._startedRooms.has(roomId);

        if (creatorId === playerId && !gameStarted) {

            this._closeRoom(roomId, "creator_left");

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
