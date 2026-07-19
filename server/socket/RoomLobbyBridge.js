import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { ICONS } from "../catalog/Icons.js";
import {
    isAllowedBaseStake,
    isValidPlayerAge
} from "../models/PlayerProfileRules.js";
import {
    normalizeSecretMatrix,
    secretMatricesMatch
} from "../models/SecretMatrixRules.js";
import { normalizeTelegramWallet } from "../models/TelegramWalletRules.js";
import {
    ENTRY_SMART_CONTRACT_STATUS,
    EntryPaymentSession
} from "../models/EntryPaymentSession.js";
import { EntryPaymentLifecycle } from "../gameplay/EntryPaymentLifecycle.js";
import { TelegramWalletAdapter } from "../services/telegram/TelegramWalletAdapter.js";
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
        setupSessionLifecycle = null,
        telegramWalletAdapter = null,
        entryPaymentDelays = null
    }) {

        this._logger = logger;

        this._eventBus = eventBus;

        this._roomManager = roomManager;

        this._playerManager = playerManager;

        this._gameplayContextResolver = gameplayContextResolver;

        this._setupSessionLifecycle = setupSessionLifecycle;

        this._telegramWalletAdapter = telegramWalletAdapter
            ?? new TelegramWalletAdapter({ logger });

        this._entryPaymentLifecycle = new EntryPaymentLifecycle({
            logger,
            telegramWalletAdapter: this._telegramWalletAdapter,
            applySessionUpdate: (roomId, updater) => (
                this._applyEntryPaymentUpdate(roomId, updater)
            ),
            playerPaymentDelayMs: entryPaymentDelays?.playerPaymentDelayMs
                ?? 750,
            smartContractDelayMs: entryPaymentDelays?.smartContractDelayMs
                ?? 500
        });

        // C5.8E — authoritative 3s display after smartContractStatus=created.
        this._entryPaymentCompletionDelayMs = entryPaymentDelays
            ?.completionDelayMs
            ?? 3000;

        // roomId → { timeoutId, startedAt, durationMs }
        this._entryPaymentCompletionTimerByRoom = new Map();

        // Rooms that have already emitted ENTRY_PAYMENT_COMPLETED.
        this._entryPaymentCompletedByRoom = new Set();

        this._socketToPlayer = new Map();

        this._playerToSocket = new Map();

        this._roomCreators = new Map();

        // Server-owned recovery identity keyed by socket id (stashed on soft disconnect).
        this._recoveryOwnershipBySocket = new Map();

        // Rooms whose Game Session has started (post Setup Session completion).
        this._startedRooms = new Set();

        // Verify barrier: profiles stay private until every player confirms.
        this._verifyConfirmedByRoom = new Map();

        this._profilesRevealedByRoom = new Set();

        // C5.8A — continuation barrier: all verified players press NEXT before
        // PAYMENT_STAGE_READY. Keyed by roomId → Set(playerId).
        this._continueToPaymentByRoom = new Map();

        this._paymentStageReadyByRoom = new Set();

        // C5.8C — Entry Payment Session (Page4). One per room.
        // Separate from winner-settlement PaymentEngine.
        this._entryPaymentByRoom = new Map();

        // Secret Matrix submissions keyed by roomId → Map(playerId → cells).
        this._secretMatrixByRoom = new Map();

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
            EVENT_TYPES.LOBBY_UPDATE_PLAYER_PROFILE_REQUEST,
            (envelope) => {

                this._handleUpdatePlayerProfile(
                    envelope.payload.socketId,
                    envelope.payload.profile
                );

            }
        );

        this._subscribe(
            EVENT_TYPES.LOBBY_SUBMIT_SECRET_MATRIX_REQUEST,
            (envelope) => {

                this._handleSubmitSecretMatrix(
                    envelope.payload.socketId,
                    envelope.payload.matrix
                );

            }
        );

        this._subscribe(
            EVENT_TYPES.LOBBY_CONFIRM_VERIFY_REQUEST,
            (envelope) => {

                this._handleConfirmVerify(envelope.payload.socketId);

            }
        );

        this._subscribe(
            EVENT_TYPES.LOBBY_VERIFY_NEXT_REQUEST,
            (envelope) => {

                this._handleVerifyNextRequest(
                    envelope.payload.socketId,
                    envelope.payload.walletAddress
                );

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

        this._verifyConfirmedByRoom.clear();

        this._profilesRevealedByRoom.clear();

        this._continueToPaymentByRoom.clear();

        this._paymentStageReadyByRoom.clear();

        this._entryPaymentLifecycle.shutdown();

        for (const roomId of [
            ...this._entryPaymentCompletionTimerByRoom.keys()
        ]) {

            this._clearEntryPaymentCompletionTimer(roomId);

        }

        this._entryPaymentByRoom.clear();

        this._entryPaymentCompletedByRoom.clear();

        this._secretMatrixByRoom.clear();

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

        const syncPayload = this._setupSessionLifecycle?.buildSyncPayload(roomId);

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

        // Re-deliver authoritative stage barriers so reconnect preserves
        // continueToPayment progress and does not strand the client on Verify.
        if (this._profilesRevealedByRoom.has(roomId)) {

            this._deliverToSocket(
                socketId,
                LOBBY_SERVER_EVENTS.VERIFY_COMPLETED,
                {
                    roomId,
                    players: this._buildPlayerList(room)
                }
            );

            // Restore authoritative wallet privately to the reconnecting seat.
            this._deliverOwnWallet(socketId, playerId);

        }

        if (this._paymentStageReadyByRoom.has(roomId)) {

            this._deliverToSocket(
                socketId,
                LOBBY_SERVER_EVENTS.PAYMENT_STAGE_READY,
                { roomId }
            );

            const entryPayment = this._entryPaymentByRoom.get(roomId);

            if (entryPayment) {

                this._deliverToSocket(
                    socketId,
                    LOBBY_SERVER_EVENTS.ENTRY_PAYMENT_SESSION_UPDATED,
                    entryPayment.toSnapshot()
                );

            }

            // After ENTRY_PAYMENT_COMPLETED, reconnect must enter Page5.
            if (this._entryPaymentCompletedByRoom.has(roomId)) {

                this._deliverToSocket(
                    socketId,
                    LOBBY_SERVER_EVENTS.ENTRY_PAYMENT_COMPLETED,
                    { roomId }
                );

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

            this._clearVerifyBarrier(roomId);

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

        const setup = this._setupSessionLifecycle?.buildSyncPayload(roomId)
            ?? null;

        const startGamePayload = {
            roomId,
            gameId,
            maxPlayers: room.maxPlayers,
            players,
            setup
        };

        for (const playerId of room.players) {

            const socketId = this._playerToSocket.get(playerId);

            if (!socketId) {

                continue;

            }

            // Per-recipient playerId so the filling joiner still binds identity
            // when startGame races ahead of roomJoined.
            this._deliverToSocket(
                socketId,
                LOBBY_SERVER_EVENTS.START_GAME,
                {
                    ...startGamePayload,
                    playerId
                }
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

        this._clearVerifyBarrier(roomId);

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

        const reveal = this._profilesRevealedByRoom.has(room.roomId);

        return room.players.map((playerId) => {

            const identity = this._playerManager.getIdentity(playerId);

            return this._mapIdentityToLobbyPlayer(identity, playerId, { reveal });

        });

    }

    _mapIdentityToLobbyPlayer(identity, playerId, { reveal = false } = {}) {

        const resolvedId = identity?.playerId ?? playerId;

        // Pre-Confirm public identity: nickname / age / icon / sectorCount so
        // peers can verify participants. Color, arrangement and all private
        // crypto/wallet/matrix fields stay hidden until VERIFY_COMPLETED.
        if (!reveal) {

            const sectorCount = identity?.sectorCount ?? null;

            return {
                playerId: resolvedId,
                nickname: identity?.nickname ?? null,
                age: identity?.age ?? null,
                icon: identity?.icon ?? null,
                color: null,
                sectorCount,
                sectorArrangement: null,
                sectorLabel: "SECTOR",
                sectorValue: sectorCount != null ? String(sectorCount) : null
            };

        }

        const sectorCount = identity?.sectorCount ?? null;

        const arrangement = identity?.sectorArrangement ?? null;

        let sectorLabel = "SECTOR";

        let sectorValue = sectorCount != null ? String(sectorCount) : null;

        if (sectorCount === 2) {

            sectorLabel = arrangement === "separate"
                ? "SEPARATE SECTORS"
                : "TOGETHER SECTORS";

        }

        return {
            playerId: resolvedId,
            nickname: identity?.nickname ?? null,
            age: identity?.age ?? null,
            icon: identity?.icon ?? null,
            color: identity?.color ?? null,
            sectorCount,
            sectorArrangement: arrangement,
            sectorLabel,
            sectorValue
        };

    }

    _handleUpdatePlayerProfile(socketId, rawProfile) {

        const context = this._getSocketContext(socketId);

        if (!context) {

            this._emitRoomError(socketId, LOBBY_ERROR_CODES.UNKNOWN_ERROR);

            return;

        }

        const { playerId, roomId } = context;

        const profile = this._normalizePlayerProfile(rawProfile);

        if (!profile) {

            this._emitRoomError(socketId, LOBBY_ERROR_CODES.UNKNOWN_ERROR);

            return;

        }

        if (!isValidPlayerAge(profile.age)) {

            this._logger.error(
                `Player profile rejected: invalid age (${profile.age}) | playerId=${playerId}`
            );

            this._emitRoomError(socketId, LOBBY_ERROR_CODES.UNKNOWN_ERROR);

            return;

        }

        if (profile.baseStake != null && !isAllowedBaseStake(profile.baseStake)) {

            this._logger.error(
                `Player profile rejected: invalid stake (${profile.baseStake}) | playerId=${playerId}`
            );

            this._emitRoomError(socketId, LOBBY_ERROR_CODES.UNKNOWN_ERROR);

            return;

        }

        const existing = this._playerManager.getIdentity(playerId);

        const icon = existing?.icon
            ?? this._assignUniqueIcon(roomId);

        const identity = this._playerManager.updateIdentity(playerId, {
            nickname: profile.nickname,
            age: profile.age,
            icon,
            color: profile.color,
            sectorCount: profile.sectorCount,
            sectorArrangement: profile.sectorArrangement
        });

        if (!identity) {

            this._emitRoomError(socketId, LOBBY_ERROR_CODES.UNKNOWN_ERROR);

            return;

        }

        const room = this._roomManager.getRoom(roomId);

        if (!room) {

            this._emitRoomError(socketId, LOBBY_ERROR_CODES.ROOM_NOT_FOUND);

            return;

        }

        // Self-ack with full profile — peers receive public identity
        // (nickname/age/icon/sectorCount) so Verify can confirm participants
        // without leaking color/arrangement or private crypto/wallet fields.
        const fullPayload = this._mapIdentityToLobbyPlayer(
            identity,
            playerId,
            { reveal: true }
        );

        const redactedPayload = this._mapIdentityToLobbyPlayer(
            identity,
            playerId,
            { reveal: false }
        );

        this._deliverToSocket(
            socketId,
            LOBBY_SERVER_EVENTS.PLAYER_UPDATE,
            fullPayload
        );

        for (const peerId of room.players) {

            if (peerId === playerId) {

                continue;

            }

            const peerSocketId = this._playerToSocket.get(peerId);

            if (!peerSocketId) {

                continue;

            }

            this._deliverToSocket(
                peerSocketId,
                LOBBY_SERVER_EVENTS.PLAYER_UPDATE,
                redactedPayload
            );

        }

        this._logger.info(
            `Lobby player profile updated (private) | roomId=${roomId} | playerId=${playerId}`
        );

    }

    _handleSubmitSecretMatrix(socketId, rawMatrix) {

        const context = this._getSocketContext(socketId);

        if (!context) {

            this._emitRoomError(socketId, LOBBY_ERROR_CODES.UNKNOWN_ERROR);

            return;

        }

        const { playerId, roomId } = context;

        const room = this._roomManager.getRoom(roomId);

        if (!room) {

            this._emitRoomError(socketId, LOBBY_ERROR_CODES.ROOM_NOT_FOUND);

            return;

        }

        const cells = normalizeSecretMatrix(rawMatrix);

        if (!cells) {

            this._deliverToSocket(
                socketId,
                LOBBY_SERVER_EVENTS.SECRET_MATRIX_REJECTED,
                {
                    roomId,
                    code: LOBBY_ERROR_CODES.INVALID_SECRET_MATRIX,
                    message: LOBBY_ERROR_MESSAGES[
                        LOBBY_ERROR_CODES.INVALID_SECRET_MATRIX
                    ]
                }
            );

            return;

        }

        let submissions = this._secretMatrixByRoom.get(roomId);

        if (!submissions) {

            submissions = new Map();

            this._secretMatrixByRoom.set(roomId, submissions);

        }

        submissions.set(playerId, cells);

        this._logger.info(
            `Secret Matrix submitted | roomId=${roomId} | playerId=${playerId} | `
                + `${submissions.size}/${room.players.length}`
        );

        if (submissions.size < room.players.length) {

            return;

        }

        const matrices = room.players.map(
            (id) => submissions.get(id) ?? null
        );

        if (!secretMatricesMatch(matrices)) {

            this._secretMatrixByRoom.delete(roomId);

            this._deliverToRoom(
                roomId,
                LOBBY_SERVER_EVENTS.SECRET_MATRIX_REJECTED,
                {
                    roomId,
                    code: LOBBY_ERROR_CODES.SECRET_MATRIX_MISMATCH,
                    message: LOBBY_ERROR_MESSAGES[
                        LOBBY_ERROR_CODES.SECRET_MATRIX_MISMATCH
                    ]
                }
            );

            this._logger.info(
                `Secret Matrix mismatch | roomId=${roomId}`
            );

            return;

        }

        this._secretMatrixByRoom.delete(roomId);

        this._deliverToRoom(
            roomId,
            LOBBY_SERVER_EVENTS.SECRET_MATRIX_ACCEPTED,
            { roomId }
        );

        this._logger.info(`Secret Matrix accepted | roomId=${roomId}`);

    }

    _handleConfirmVerify(socketId) {

        const context = this._getSocketContext(socketId);

        if (!context) {

            this._emitRoomError(socketId, LOBBY_ERROR_CODES.UNKNOWN_ERROR);

            return;

        }

        const { playerId, roomId } = context;

        const room = this._roomManager.getRoom(roomId);

        if (!room) {

            this._emitRoomError(socketId, LOBBY_ERROR_CODES.ROOM_NOT_FOUND);

            return;

        }

        if (this._profilesRevealedByRoom.has(roomId)) {

            this._deliverToSocket(
                socketId,
                LOBBY_SERVER_EVENTS.VERIFY_COMPLETED,
                {
                    roomId,
                    players: this._buildPlayerList(room)
                }
            );

            return;

        }

        let confirmed = this._verifyConfirmedByRoom.get(roomId);

        if (!confirmed) {

            confirmed = new Set();

            this._verifyConfirmedByRoom.set(roomId, confirmed);

        }

        confirmed.add(playerId);

        this._logger.info(
            `Verify confirmed | roomId=${roomId} | playerId=${playerId} | `
                + `${confirmed.size}/${room.players.length}`
        );

        if (confirmed.size < room.players.length) {

            return;

        }

        this._revealVerifyRoster(roomId, room);

    }

    _handleVerifyNextRequest(socketId, rawWalletAddress) {

        const context = this._getSocketContext(socketId);

        if (!context) {

            this._emitRoomError(socketId, LOBBY_ERROR_CODES.UNKNOWN_ERROR);

            return;

        }

        const { playerId, roomId } = context;

        const room = this._roomManager.getRoom(roomId);

        if (!room) {

            this._emitRoomError(socketId, LOBBY_ERROR_CODES.ROOM_NOT_FOUND);

            return;

        }

        // Continuation is only valid after VERIFY_COMPLETED.
        if (!this._profilesRevealedByRoom.has(roomId)) {

            this._emitRoomError(socketId, LOBBY_ERROR_CODES.UNKNOWN_ERROR);

            return;

        }

        if (this._paymentStageReadyByRoom.has(roomId)) {

            this._deliverToSocket(
                socketId,
                LOBBY_SERVER_EVENTS.PAYMENT_STAGE_READY,
                { roomId }
            );

            return;

        }

        let continued = this._continueToPaymentByRoom.get(roomId);

        if (!continued) {

            continued = new Set();

            this._continueToPaymentByRoom.set(roomId, continued);

        }

        // Exactly one submission per player; duplicates are ignored.
        if (continued.has(playerId)) {

            return;

        }

        const wallet = normalizeTelegramWallet(rawWalletAddress);

        if (!wallet) {

            this._deliverToSocket(
                socketId,
                LOBBY_SERVER_EVENTS.WALLET_REJECTED,
                {
                    roomId,
                    code: LOBBY_ERROR_CODES.INVALID_WALLET,
                    message: LOBBY_ERROR_MESSAGES[
                        LOBBY_ERROR_CODES.INVALID_WALLET
                    ]
                }
            );

            return;

        }

        const stored = this._playerManager.updateIdentity(playerId, { wallet });

        if (!stored) {

            this._emitRoomError(socketId, LOBBY_ERROR_CODES.UNKNOWN_ERROR);

            return;

        }

        // Private ack so reconnect / local mirror can restore ownership.
        this._deliverOwnWallet(socketId, playerId);

        continued.add(playerId);

        this._logger.info(
            `Verify NEXT continue | roomId=${roomId} | playerId=${playerId} | `
                + `${continued.size}/${room.players.length}`
        );

        if (continued.size < room.players.length) {

            return;

        }

        this._broadcastPaymentStageReady(roomId);

    }

    _deliverOwnWallet(socketId, playerId) {

        const identity = this._playerManager.getIdentity(playerId);

        if (!identity?.wallet) {

            return;

        }

        this._deliverToSocket(
            socketId,
            LOBBY_SERVER_EVENTS.PLAYER_UPDATE,
            {
                playerId,
                wallet: identity.wallet
            }
        );

    }

    _broadcastPaymentStageReady(roomId) {

        if (this._paymentStageReadyByRoom.has(roomId)) {

            return;

        }

        this._paymentStageReadyByRoom.add(roomId);

        this._deliverToRoom(
            roomId,
            LOBBY_SERVER_EVENTS.PAYMENT_STAGE_READY,
            { roomId }
        );

        this._logger.info(`Payment stage ready | roomId=${roomId}`);

        this._createAndBroadcastEntryPaymentSession(roomId);

    }

    _createAndBroadcastEntryPaymentSession(roomId) {

        if (this._entryPaymentByRoom.has(roomId)) {

            this._broadcastEntryPaymentSession(roomId);

            return;

        }

        const room = this._roomManager.getRoom(roomId);

        if (!room) {

            return;

        }

        const roster = room.players.map((playerId) => {

            const identity = this._playerManager.getIdentity(playerId);

            return {
                playerId,
                wallet: identity?.wallet ?? null
            };

        });

        const session = EntryPaymentSession.createInitial(roomId, roster);

        this._entryPaymentByRoom.set(roomId, session);

        this._broadcastEntryPaymentSession(roomId);

        this._entryPaymentLifecycle.start(roomId, session);

        this._logger.info(
            `Entry payment session created | roomId=${roomId} | `
                + `players=${session.players.length}`
        );

    }

    _applyEntryPaymentUpdate(roomId, updater) {

        const current = this._entryPaymentByRoom.get(roomId);

        if (!current) {

            return null;

        }

        const next = updater(current);

        if (!next || next === current) {

            return current;

        }

        this._entryPaymentByRoom.set(roomId, next);

        this._broadcastEntryPaymentSession(roomId);

        if (next.smartContractStatus === ENTRY_SMART_CONTRACT_STATUS.CREATED) {

            this._startEntryPaymentCompletionTimer(roomId);

        }

        return next;

    }

    _startEntryPaymentCompletionTimer(roomId) {

        if (this._entryPaymentCompletedByRoom.has(roomId)) {

            return;

        }

        // Do not restart — reconnect during the 3s display keeps this timer.
        if (this._entryPaymentCompletionTimerByRoom.has(roomId)) {

            return;

        }

        const durationMs = this._entryPaymentCompletionDelayMs;

        const startedAt = Date.now();

        const timeoutId = setTimeout(() => {

            this._completeEntryPayment(roomId);

        }, durationMs);

        this._entryPaymentCompletionTimerByRoom.set(roomId, {
            timeoutId,
            startedAt,
            durationMs
        });

        this._logger.info(
            `Entry payment completion timer started | roomId=${roomId} | `
                + `durationMs=${durationMs}`
        );

    }

    _completeEntryPayment(roomId) {

        if (this._entryPaymentCompletedByRoom.has(roomId)) {

            return;

        }

        this._clearEntryPaymentCompletionTimer(roomId);

        this._entryPaymentCompletedByRoom.add(roomId);

        this._deliverToRoom(
            roomId,
            LOBBY_SERVER_EVENTS.ENTRY_PAYMENT_COMPLETED,
            { roomId }
        );

        this._logger.info(`Entry payment completed | roomId=${roomId}`);

        // Lifecycle timers are finished; keep EntryPaymentSession until room
        // cleanup so late reconnect can still restore the final snapshot +
        // ENTRY_PAYMENT_COMPLETED.
        this._entryPaymentLifecycle.cancel(roomId);

    }

    _clearEntryPaymentCompletionTimer(roomId) {

        const active = this._entryPaymentCompletionTimerByRoom.get(roomId);

        if (!active) {

            return;

        }

        clearTimeout(active.timeoutId);

        this._entryPaymentCompletionTimerByRoom.delete(roomId);

    }

    _destroyEntryPaymentArtifacts(roomId) {

        this._entryPaymentLifecycle.cancel(roomId);

        this._clearEntryPaymentCompletionTimer(roomId);

        this._entryPaymentByRoom.delete(roomId);

        this._entryPaymentCompletedByRoom.delete(roomId);

    }

    _broadcastEntryPaymentSession(roomId) {

        const session = this._entryPaymentByRoom.get(roomId);

        if (!session) {

            return;

        }

        this._deliverToRoom(
            roomId,
            LOBBY_SERVER_EVENTS.ENTRY_PAYMENT_SESSION_UPDATED,
            session.toSnapshot()
        );

    }

    _revealVerifyRoster(roomId, room) {

        this._profilesRevealedByRoom.add(roomId);

        const revealedPlayers = [];

        for (const playerId of room.players) {

            const identity = this._playerManager.getIdentity(playerId);

            const playerPayload = this._mapIdentityToLobbyPlayer(
                identity,
                playerId,
                { reveal: true }
            );

            revealedPlayers.push(playerPayload);

            this._deliverToRoom(
                roomId,
                LOBBY_SERVER_EVENTS.PLAYER_UPDATE,
                playerPayload
            );

        }

        this._broadcastRoomState(roomId);

        // VERIFY_COMPLETED carries the full authoritative roster so clients
        // apply reveal atomically even if individual PLAYER_UPDATE ordering
        // races with navigation.
        this._deliverToRoom(
            roomId,
            LOBBY_SERVER_EVENTS.VERIFY_COMPLETED,
            {
                roomId,
                players: revealedPlayers
            }
        );

        this._logger.info(`Verify completed | roomId=${roomId}`);

    }

    _clearVerifyBarrier(roomId) {

        this._verifyConfirmedByRoom.delete(roomId);

        this._profilesRevealedByRoom.delete(roomId);

        this._continueToPaymentByRoom.delete(roomId);

        this._paymentStageReadyByRoom.delete(roomId);

        this._destroyEntryPaymentArtifacts(roomId);

        this._secretMatrixByRoom.delete(roomId);

    }

    _normalizePlayerProfile(rawProfile) {

        if (!rawProfile || typeof rawProfile !== "object") {

            return null;

        }

        const nickname = typeof rawProfile.nickname === "string"
            ? rawProfile.nickname.trim().slice(0, 4)
            : "";

        const age = Number(rawProfile.age);

        const sectorCount = Number(rawProfile.sectorCount) === 2 ? 2 : 1;

        const sectorArrangement = rawProfile.sectorArrangement === "separate"
            ? "separate"
            : "together";

        const color = typeof rawProfile.color === "string"
            ? rawProfile.color.trim().slice(0, 32)
            : null;

        const baseStake = rawProfile.baseStake === undefined
            || rawProfile.baseStake === null
            ? null
            : Number(rawProfile.baseStake);

        return {
            nickname: nickname || null,
            age,
            sectorCount,
            sectorArrangement,
            color,
            baseStake
        };

    }

    _assignUniqueIcon(roomId) {

        const room = this._roomManager.getRoom(roomId);

        const used = new Set(
            (room?.players ?? [])
                .map((id) => this._playerManager.getIdentity(id)?.icon)
                .filter(Boolean)
        );

        const available = ICONS.find((entry) => !used.has(entry.glyph))
            ?? ICONS[0];

        return available.glyph;

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
