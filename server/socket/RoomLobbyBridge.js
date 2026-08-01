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
import {
    areRoomPage2ProfilesComplete,
    areRoomPlayerProfilesComplete,
    isPage2ProfileComplete,
    isPlayerProfileComplete
} from "../managers/playerProfileCompleteness.js";
import { CONNECTION_STATE } from "../models/ConnectionState.js";
import { PLAYER_STATE } from "../models/PlayerState.js";
import { ROOM_STATUS } from "../models/RoomStatus.js";
import {
    WalletConnectionSession
} from "../models/WalletConnectionSession.js";
import {
    canonicalizeTonWalletAddress,
    sessionWalletsMatch
} from "../models/TonWalletAddress.js";
import {
    LOBBY_ERROR_CODES,
    LOBBY_ERROR_MESSAGES,
    LOBBY_SERVER_EVENTS
} from "./lobbyProtocol.js";

import { SessionWalletStore } from "../session/SessionWalletStore.js";

export class RoomLobbyBridge {

    constructor({
        logger,
        eventBus,
        roomManager,
        playerManager,
        gameplayContextResolver = null,
        setupSessionLifecycle = null,
        resultSessionLifecycle = null,
        paymentSessionManager = null,
        gameContractManager = null,
        gameStartAuthorization = null,
        contractSettlementManager = null,
        sessionWalletStore = null,
        telegramWalletAdapter = null,
        entryPaymentDelays = null,
        isDevelopment = false,
        lifecycleManager = null
    }) {

        this._logger = logger;

        this._eventBus = eventBus;

        this._roomManager = roomManager;

        this._playerManager = playerManager;

        this._gameplayContextResolver = gameplayContextResolver;

        this._setupSessionLifecycle = setupSessionLifecycle;

        this._resultSessionLifecycle = resultSessionLifecycle;

        this._paymentSessionManager = paymentSessionManager;

        this._gameContractManager = gameContractManager;

        this._gameStartAuthorization = gameStartAuthorization;

        this._contractSettlementManager = contractSettlementManager;

        // R7.0B — drain awareness for lobby create-room.
        this._lifecycleManager = lifecycleManager;

        // R1.3D — DEBUG_START_GAME is development-only.
        this._isDevelopment = isDevelopment === true;

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

        // Server-owned recovery identity keyed by socket id (CSR / same-id path).
        this._recoveryOwnershipBySocket = new Map();

        // R6.1 — Server-owned recovery identity keyed by persistent playerId.
        // New socket.id reclaim uses this map; client claim is only a lookup key.
        this._recoveryOwnershipByPlayer = new Map();

        this._lastRecoveryDenial = null;

        // Rooms whose Game Session has started (post Setup Session completion).
        this._startedRooms = new Set();

        // R6.5 — rooms currently running the single SESSION_FINISHED cleanup path.
        this._finishingResultSessions = new Set();

        // P6.1 — session wallets keyed by room (not PlayerIdentity).
        this._sessionWalletStore = sessionWalletStore ?? new SessionWalletStore();

        // Verify barrier: profiles stay private until every player confirms.
        this._verifyConfirmedByRoom = new Map();

        this._profilesRevealedByRoom = new Set();

        // R5.15 — rooms that have emitted ALL_PLAYER_PROFILES_READY (once).
        this._allProfilesReadyByRoom = new Set();

        // R5.17 — rooms that have received VERIFY-phase icon assignment (once).
        this._verifyIconsAssignedByRoom = new Set();

        // C5.8A — continuation barrier: all verified players press NEXT before
        // PAYMENT_STAGE_READY. Keyed by roomId → Set(playerId).
        this._continueToPaymentByRoom = new Map();

        this._paymentStageReadyByRoom = new Set();

        // C5.8C — Entry Payment Session (Page4). One per room.
        // Separate from winner-settlement PaymentEngine.
        this._entryPaymentByRoom = new Map();

        // P6.2 — Telegram Wallet connection session (Page4). One per room.
        this._walletConnectionByRoom = new Map();

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
            EVENT_TYPES.LOBBY_WALLET_CONNECT_STARTED_REQUEST,
            (envelope) => {

                this._handleWalletConnectStarted(envelope.payload.socketId);

            }
        );

        this._subscribe(
            EVENT_TYPES.LOBBY_WALLET_CONNECT_REPORT_REQUEST,
            (envelope) => {

                this._handleWalletConnectReport(
                    envelope.payload.socketId,
                    envelope.payload.connectedWallet
                );

            }
        );

        this._subscribe(
            EVENT_TYPES.LOBBY_WALLET_DISCONNECT_REPORT_REQUEST,
            (envelope) => {

                this._handleWalletDisconnectReport(envelope.payload.socketId);

            }
        );

        this._subscribe(
            EVENT_TYPES.LOBBY_DEBUG_START_GAME_REQUEST,
            (envelope) => {

                this._handleDebugStartGame(envelope.payload.socketId);

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
            EVENT_TYPES.GAME_CREATED,
            (envelope) => {

                this._handleGameCreated(envelope.payload);

            }
        );

        this._subscribe(
            EVENT_TYPES.GAME_INITIALIZED,
            (envelope) => {

                this._handleGameInitialized(envelope.payload);

            }
        );

        this._subscribe(
            EVENT_TYPES.OPEN_PAGE6,
            (envelope) => {

                this._deliverOpenPage6(envelope.payload);

            }
        );

        this._subscribe(
            EVENT_TYPES.RESULT_SESSION_EXPIRED,
            (envelope) => {

                this._handleResultSessionExpired(envelope.payload);

            }
        );

        this._subscribe(
            EVENT_TYPES.PAYMENT_SESSION_CREATED,
            (envelope) => {

                this._deliverPaymentSessionCreated(envelope.payload);

            }
        );

        this._subscribe(
            EVENT_TYPES.PAYMENT_SESSION_UPDATED,
            (envelope) => {

                this._deliverPaymentSessionUpdated(envelope.payload);

            }
        );

        this._subscribe(
            EVENT_TYPES.PAYMENT_REQUEST,
            (envelope) => {

                this._deliverPaymentRequest(envelope.payload);

            }
        );

        this._subscribe(
            EVENT_TYPES.PAYMENT_SESSION_COMPLETED,
            (envelope) => {

                this._deliverPaymentSessionCompleted(envelope.payload);

            }
        );

        this._subscribe(
            EVENT_TYPES.PAYMENT_SESSION_FAILED,
            (envelope) => {

                this._handlePaymentSessionFailed(envelope.payload);

            }
        );

        this._subscribe(
            EVENT_TYPES.LOBBY_PAYMENT_CONFIRM_INTENT_REQUEST,
            (envelope) => {

                this._handlePaymentConfirmIntent(envelope.payload.socketId);

            }
        );

        this._subscribe(
            EVENT_TYPES.LOBBY_PAYMENT_CANCEL_INTENT_REQUEST,
            (envelope) => {

                this._handlePaymentCancelIntent(envelope.payload.socketId);

            }
        );

        this._subscribe(
            EVENT_TYPES.GAME_CONTRACT_UPDATED,
            (envelope) => {

                this._deliverGameContractUpdated(envelope.payload);

            }
        );

        this._subscribe(
            EVENT_TYPES.GAME_CONTRACT_DEPLOYED,
            (envelope) => {

                this._deliverGameContractDeployed(envelope.payload);

            }
        );

        this._subscribe(
            EVENT_TYPES.GAME_CONTRACT_DEPLOY_FAILED,
            (envelope) => {

                this._handleGameContractDeployFailed(envelope.payload);

            }
        );

        this._subscribe(
            EVENT_TYPES.GAME_START_AUTHORIZED,
            (envelope) => {

                this._deliverGameStartAuthorized(envelope.payload);

            }
        );

        this._subscribe(
            EVENT_TYPES.GAME_INITIALIZING,
            (envelope) => {

                this._deliverGameInitializing(envelope.payload);

            }
        );

        this._subscribe(
            EVENT_TYPES.GAME_START_BOOTSTRAP_READY,
            (envelope) => {

                this._handleGameStartBootstrapReady(envelope.payload);

            }
        );

        this._subscribe(
            EVENT_TYPES.GAME_START_FAILED,
            (envelope) => {

                this._handleGameStartFailed(envelope.payload);

            }
        );

        this._subscribe(
            EVENT_TYPES.SETTLEMENT_STARTED,
            (envelope) => {

                this._deliverSettlementEvent(
                    LOBBY_SERVER_EVENTS.SETTLEMENT_STARTED,
                    envelope.payload
                );

            }
        );

        this._subscribe(
            EVENT_TYPES.SETTLEMENT_SUBMITTED,
            (envelope) => {

                this._deliverSettlementEvent(
                    LOBBY_SERVER_EVENTS.SETTLEMENT_SUBMITTED,
                    envelope.payload
                );

            }
        );

        this._subscribe(
            EVENT_TYPES.SETTLEMENT_CONFIRMED,
            (envelope) => {

                this._deliverSettlementEvent(
                    LOBBY_SERVER_EVENTS.SETTLEMENT_CONFIRMED,
                    envelope.payload
                );

            }
        );

        this._subscribe(
            EVENT_TYPES.SETTLEMENT_COMPLETED,
            (envelope) => {

                this._deliverSettlementEvent(
                    LOBBY_SERVER_EVENTS.SETTLEMENT_COMPLETED,
                    envelope.payload
                );

            }
        );

        this._subscribe(
            EVENT_TYPES.SETTLEMENT_FAILED,
            (envelope) => {

                this._deliverSettlementEvent(
                    LOBBY_SERVER_EVENTS.SETTLEMENT_FAILED,
                    envelope.payload
                );

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

        this._recoveryOwnershipBySocket.clear();

        this._recoveryOwnershipByPlayer.clear();

        this._startedRooms.clear();

        this._finishingResultSessions.clear();

        this._sessionWalletStore.clearAll();

        this._verifyConfirmedByRoom.clear();

        this._profilesRevealedByRoom.clear();

        this._allProfilesReadyByRoom.clear();

        this._verifyIconsAssignedByRoom.clear();

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

        this._walletConnectionByRoom.clear();

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

        if (this._lifecycleManager
            && this._lifecycleManager.isAcceptingNewWork() !== true) {

            this._emitRoomError(
                socketId,
                LOBBY_ERROR_CODES.SERVER_DRAINING
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

            const draining = this._lifecycleManager
                && this._lifecycleManager.isAcceptingNewWork() !== true;

            this._emitRoomError(
                socketId,
                draining
                    ? LOBBY_ERROR_CODES.SERVER_DRAINING
                    : this._roomManager.isAtCapacity()
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
                `[R6.2A Recovery] soft disconnect`
                + ` | roomId=${context.roomId}`
                + ` | playerId=${context.playerId}`
                + ` | socket.id=${socketId}`
            );

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
     *
     * Lookup order:
     * 1. Active socket binding
     * 2. Soft-disconnect stash keyed by socket.id (CSR / same-id)
     * 3. Soft-disconnect stash keyed by persistent playerId (claim)
     *
     * A client claim may only select a pre-existing server stash. It never
     * invents identity, room membership, or ownership.
     */
    resolveRecoveryIdentity(socketId, claim = null) {

        if (!socketId) {

            return null;

        }

        const activeContext = this._getSocketContext(socketId);

        if (activeContext) {

            this._logger.info(
                `[R6.2A Recovery] stash lookup`
                + ` | roomId=${activeContext.roomId}`
                + ` | playerId=${activeContext.playerId}`
                + ` | socket.id=${socketId}`
                + ` | source=active context`
            );

            return {
                playerId: activeContext.playerId,
                roomId: activeContext.roomId
            };

        }

        const stashedBySocket = this._recoveryOwnershipBySocket.get(socketId);

        if (stashedBySocket) {

            if (!this._isRecoverableIdentity(
                stashedBySocket.playerId,
                stashedBySocket.roomId
            )) {

                this._logger.info(
                    `[R6.2A Recovery] stash lookup`
                    + ` | roomId=${stashedBySocket.roomId}`
                    + ` | playerId=${stashedBySocket.playerId}`
                    + ` | socket.id=${socketId}`
                    + ` | source=socket stash`
                    + ` | result=not recoverable`
                );

                this._clearRecoveryOwnershipForPlayer(stashedBySocket.playerId);

            return null;

        }

            this._logger.info(
                `[R6.2A Recovery] stash lookup`
                + ` | roomId=${stashedBySocket.roomId}`
                + ` | playerId=${stashedBySocket.playerId}`
                + ` | socket.id=${socketId}`
                + ` | source=socket stash`
                + ` | result=hit`
            );

            return stashedBySocket;

        }

        const claimedPlayerId = claim?.playerId ?? null;

        if (!claimedPlayerId) {

            this._logger.info(
                `[R6.2A Recovery] stash lookup`
                + ` | roomId=${claim?.roomId ?? "null"}`
                + ` | playerId=null`
                + ` | socket.id=${socketId}`
                + ` | source=player claim`
                + ` | result=miss (no claim)`
            );

            return null;

        }

        const stashedByPlayer = this._recoveryOwnershipByPlayer.get(
            claimedPlayerId
        );

        if (!stashedByPlayer) {

            this._logger.info(
                `[R6.2A Recovery] stash lookup`
                + ` | roomId=${claim?.roomId ?? "null"}`
                + ` | playerId=${claimedPlayerId}`
                + ` | socket.id=${socketId}`
                + ` | source=player claim`
                + ` | result=miss`
            );

            const runtimeSeat = this._tryRuntimeSeatRecovery(
                claimedPlayerId,
                claim?.roomId ?? null,
                socketId
            );

            if (runtimeSeat) {

                return runtimeSeat;

            }

            return null;

        }

        if (claim.roomId && claim.roomId !== stashedByPlayer.roomId) {

            this._logger.info(
                `[R6.2A Recovery] authorization`
                + ` | check=claim_room_matches_stash`
                + ` | result=fail`
                + ` | claimRoomId=${claim.roomId}`
                + ` | stashedRoomId=${stashedByPlayer.roomId}`
                + ` | playerId=${claimedPlayerId}`
                + ` | socket.id=${socketId}`
                + ` | previousSocket.id=${stashedByPlayer.socketId ?? "null"}`
            );

            this._denyRecoveryIdentity(
                "Recovery room claim does not match the server stash",
                {
                    claimRoomId: claim.roomId,
                    stashedRoomId: stashedByPlayer.roomId,
                    playerId: claimedPlayerId,
                    socketId,
                    previousSocketId: stashedByPlayer.socketId ?? null
                }
            );

            return null;

        }

        if (!this._isRecoverableIdentity(
            claimedPlayerId,
            stashedByPlayer.roomId
        )) {

            this._logger.info(
                `[R6.2A Recovery] stash lookup`
                + ` | roomId=${stashedByPlayer.roomId}`
                + ` | playerId=${claimedPlayerId}`
                + ` | socket.id=${socketId}`
                + ` | source=player claim`
                + ` | result=not recoverable`
            );

            this._clearRecoveryOwnershipForPlayer(claimedPlayerId);

            return null;

        }

        this._logger.info(
            `[R6.2A Recovery] stash lookup`
            + ` | roomId=${stashedByPlayer.roomId}`
            + ` | playerId=${claimedPlayerId}`
            + ` | socket.id=${socketId}`
            + ` | source=player claim`
            + ` | result=hit`
        );

        return {
            playerId: claimedPlayerId,
            roomId: stashedByPlayer.roomId
        };

    }

    /**
     * Rebind a socket for Setup Session or Game Session recovery.
     * Identity is resolved exclusively from server-owned recovery ownership.
     * Setup reconnect never restarts the timer / session.
     */
    reconnectSession(socketId, claim = null) {

        this._lastRecoveryDenial = null;

        const previousSocketId = claim?.playerId
            ? this.getRecoveryOwnershipDebug(claim.playerId).previousSocketId
            : null;

        this._logger.info(
            `[R6.2A Recovery] authorization begin`
            + ` | roomId=${claim?.roomId ?? "null"}`
            + ` | playerId=${claim?.playerId ?? "null"}`
            + ` | socket.id=${socketId ?? "null"}`
            + ` | previousSocket.id=${previousSocketId ?? "null"}`
        );

        const identity = this.resolveRecoveryIdentity(socketId, claim);

        if (!identity) {

            const reason = this._lastRecoveryDenial?.reason
                ?? "Recovery identity is not authorized for this socket";

            this._logger.info(
                `[R6.2A Recovery] reclaim failure`
                + ` | roomId=${claim?.roomId ?? "null"}`
                + ` | playerId=${claim?.playerId ?? "null"}`
                + ` | socket.id=${socketId ?? "null"}`
                + ` | previousSocket.id=${previousSocketId ?? "null"}`
                + ` | reason=${reason}`
            );

            return {
                ok: false,
                reason
            };

        }

        const { playerId, roomId } = identity;

        const room = this._roomManager.getRoom(roomId);

        this._logger.info(
            `[R6.2A Recovery] authorization`
            + ` | check=room_exists`
            + ` | result=${room ? "pass" : "fail"}`
            + ` | roomId=${roomId}`
            + ` | playerId=${playerId}`
            + ` | socket.id=${socketId}`
        );

        if (!room) {

            this._denyRecoveryIdentity("Room session is not active", {
                roomId,
                playerId,
                socketId
            });

            this._logger.info(
                `[R6.2A Recovery] reclaim failure`
                + ` | roomId=${roomId}`
                + ` | playerId=${playerId}`
                + ` | socket.id=${socketId}`
                + ` | reason=Room session is not active`
            );

            return {
                ok: false,
                reason: "Room session is not active"
            };

        }

        const playerExists = this._playerManager.hasPlayer(playerId);

        const playerInRoom = room.players.includes(playerId);

        this._logger.info(
            `[R6.2A Recovery] authorization`
            + ` | check=player_exists`
            + ` | result=${playerExists ? "pass" : "fail"}`
            + ` | roomId=${roomId}`
            + ` | playerId=${playerId}`
            + ` | socket.id=${socketId}`
        );

        this._logger.info(
            `[R6.2A Recovery] authorization`
            + ` | check=player_in_room`
            + ` | result=${playerInRoom ? "pass" : "fail"}`
            + ` | roomId=${roomId}`
            + ` | playerId=${playerId}`
            + ` | socket.id=${socketId}`
        );

        if (!this._isRecoverableIdentity(playerId, roomId)) {

            this._logger.info(
                `[R6.2A Recovery] authorization`
                + ` | check=session_protected_and_recoverable`
                + ` | result=fail`
                + ` | roomId=${roomId}`
                + ` | playerId=${playerId}`
                + ` | socket.id=${socketId}`
            );

            this._logger.info(
                `[R6.2A Recovery] reclaim failure`
                + ` | roomId=${roomId}`
                + ` | playerId=${playerId}`
                + ` | socket.id=${socketId}`
                + ` | reason=Player session is not recoverable`
            );

            return {
                ok: false,
                reason: "Player session is not recoverable"
            };

        }

        this._logger.info(
            `[R6.2A Recovery] authorization`
            + ` | check=session_protected_and_recoverable`
            + ` | result=pass`
            + ` | roomId=${roomId}`
            + ` | playerId=${playerId}`
            + ` | socket.id=${socketId}`
        );

        this._registerSocketPlayer(socketId, playerId);

        this._playerManager.setConnectionState(
            playerId,
            CONNECTION_STATE.CONNECTED
        );

        this._attachSocketToRoom(socketId, roomId);

        this._logger.info(
            `[R6.2A Recovery] authorization`
            + ` | check=socket_rebound`
            + ` | result=pass`
            + ` | roomId=${roomId}`
            + ` | playerId=${playerId}`
            + ` | socket.id=${socketId}`
            + ` | previousSocket.id=${previousSocketId ?? "null"}`
        );

        this._logger.info(
            `[R6.2A Recovery] socket rebound`
            + ` | roomId=${roomId}`
            + ` | playerId=${playerId}`
            + ` | socket.id=${socketId}`
        );

        const runtime = this._playerManager.getRuntime(playerId);

        const gameId = this._gameplayContextResolver
            ?.resolve(socketId)?.gameId
            ?? runtime?.gameId
            ?? null;

        const setupRecoverable = this._setupSessionLifecycle
            ?.isRecoverable(roomId) === true;

        // Setup-only recovery while prep pages run. After ENTRY_PAYMENT_COMPLETED
        // (Page5), fall through to RecoveryEngine even if the Setup Timer remains.
        const setupActive = setupRecoverable
            && !this._entryPaymentCompletedByRoom.has(roomId);

        const syncPayload = this._setupSessionLifecycle?.buildSyncPayload(roomId);

        if (syncPayload) {

            this._deliverToSocket(
                socketId,
                LOBBY_SERVER_EVENTS.SETUP_SESSION_SYNC,
                syncPayload
            );

            this._logger.info(
                `[R6.2A Recovery] SETUP_SESSION_SYNC emitted`
                + ` | roomId=${roomId}`
                + ` | playerId=${playerId}`
                + ` | socket.id=${socketId}`
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

            const walletConnection = this._walletConnectionByRoom.get(roomId);

            if (walletConnection) {

                this._deliverToSocket(
                    socketId,
                    LOBBY_SERVER_EVENTS.WALLET_CONNECTION_SESSION_UPDATED,
                    walletConnection.toSnapshot()
                );

                if (walletConnection.paymentConnectionReady) {

                    this._deliverToSocket(
                        socketId,
                        LOBBY_SERVER_EVENTS.PAYMENT_CONNECTION_READY,
                        { roomId }
                    );

                }

            }

            const paymentSession = this._paymentSessionManager
                ?.getSession(roomId);

            if (paymentSession) {

                this._deliverToSocket(
                    socketId,
                    LOBBY_SERVER_EVENTS.PAYMENT_SESSION_UPDATED,
                    paymentSession.toSnapshot()
                );

            }

            const gameContract = this._gameContractManager
                ?.getContract(roomId);

            if (gameContract) {

                this._deliverToSocket(
                    socketId,
                    LOBBY_SERVER_EVENTS.GAME_CONTRACT_UPDATED,
                    gameContract.toClientSnapshot()
                );

            }

            // P6.7 — restore authoritative start gate without re-initializing.
            const gameStart = this._gameStartAuthorization
                ?.getReconnectSnapshot?.(roomId);

            if (gameStart) {

                if (
                    gameStart.phase === "GAME_START_AUTHORIZED"
                    || gameStart.phase === "GAME_INITIALIZING"
                    || gameStart.phase === "OPEN_PAGE5"
                ) {

                    this._deliverToSocket(
                        socketId,
                        LOBBY_SERVER_EVENTS.GAME_START_AUTHORIZED,
                        {
                            roomId,
                            gameId: gameStart.gameId,
                            authorizedAt: gameStart.authorizedAt,
                            blockchainCompletedAt:
                                gameStart.blockchainCompletedAt
                        }
                    );

                }

                if (
                    gameStart.phase === "GAME_INITIALIZING"
                    || gameStart.phase === "OPEN_PAGE5"
                ) {

                    this._deliverToSocket(
                        socketId,
                        LOBBY_SERVER_EVENTS.GAME_INITIALIZING,
                        {
                            roomId,
                            gameId: gameStart.gameId,
                            initializingAt: gameStart.initializingAt
                        }
                    );

                }

            }

            // After ENTRY_PAYMENT_COMPLETED, reconnect must enter Page5.
            if (this._entryPaymentCompletedByRoom.has(roomId)) {

                this._deliverToSocket(
                    socketId,
                    LOBBY_SERVER_EVENTS.ENTRY_PAYMENT_COMPLETED,
                    { roomId }
                );

                this._deliverToSocket(
                    socketId,
                    LOBBY_SERVER_EVENTS.OPEN_PAGE5,
                    { roomId }
                );

            }

            // P6.8B — restore settlement status without re-submitting.
            const settleGameId = gameId
                ?? this._gameplayContextResolver?.resolveGameIdByRoomId?.(roomId)
                ?? null;

            const settlement = settleGameId
                ? this._contractSettlementManager
                    ?.getReconnectSnapshot?.(settleGameId)
                : null;

            if (settlement) {

                const eventByStatus = {
                    SETTLEMENT_PREPARING: LOBBY_SERVER_EVENTS.SETTLEMENT_STARTED,
                    SETTLEMENT_SUBMITTED: LOBBY_SERVER_EVENTS.SETTLEMENT_SUBMITTED,
                    SETTLEMENT_PENDING: LOBBY_SERVER_EVENTS.SETTLEMENT_SUBMITTED,
                    SETTLEMENT_CONFIRMED: LOBBY_SERVER_EVENTS.SETTLEMENT_CONFIRMED,
                    SETTLEMENT_COMPLETED: LOBBY_SERVER_EVENTS.SETTLEMENT_COMPLETED,
                    SETTLEMENT_FAILED: LOBBY_SERVER_EVENTS.SETTLEMENT_FAILED
                };

                const eventName = eventByStatus[settlement.status];

                if (eventName) {

                    this._deliverToSocket(socketId, eventName, settlement);

                }

            }

        }

        this._clearRecoveryOwnershipForPlayer(playerId);

        this._logger.info(
            `[R6.2A Recovery] reclaim success`
            + ` | roomId=${roomId}`
            + ` | playerId=${playerId}`
            + ` | socket.id=${socketId}`
        );

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

    reconnectGameplaySession(socketId, claim = null) {

        return this.reconnectSession(socketId, claim);

    }

    /**
     * Release a stale player→socket binding before recovery authorization when
     * the reconnecting socket arrives before LOBBY_SOCKET_DISCONNECTED runs.
     *
     * @param {string} playerId
     * @param {string} newSocketId
     * @param {(socketId: string) => boolean} isSocketLive
     * @returns {{ released: boolean, boundSocketId: string | null } | null}
     */
    prepareRecoveryAuthorization(playerId, newSocketId, isSocketLive) {

        if (!playerId || !newSocketId || typeof isSocketLive !== "function") {

            return null;

        }

        const boundSocket = this._playerToSocket.get(playerId);

        if (!boundSocket || boundSocket === newSocketId) {

            return null;

        }

        if (isSocketLive(boundSocket)) {

            this._logger.info(
                `[R6.2A Recovery] authorization`
                + ` | check=prepare_stale_socket`
                + ` | result=skip`
                + ` | reason=bound_socket_still_live`
                + ` | boundSocket.id=${boundSocket}`
                + ` | playerId=${playerId}`
                + ` | socket.id=${newSocketId}`
            );

            return {
                released: false,
                boundSocketId: boundSocket
            };

        }

        this._logger.info(
            `[R6.2A Recovery] authorization`
            + ` | check=prepare_stale_socket`
            + ` | result=pass`
            + ` | action=soft_disconnect_stale_binding`
            + ` | boundSocket.id=${boundSocket}`
            + ` | playerId=${playerId}`
            + ` | socket.id=${newSocketId}`
        );

        this._handleSocketDisconnected(boundSocket);

        return {
            released: true,
            boundSocketId: boundSocket
        };

    }

    /**
     * Read-only recovery debug (previous socket id from soft-disconnect stash).
     */
    getRecoveryOwnershipDebug(playerId = null) {

        if (!playerId) {

            return Object.freeze({
                previousSocketId: null,
                stashedRoomId: null
            });

        }

        const stashed = this._recoveryOwnershipByPlayer.get(playerId);

        const boundSocket = this._playerToSocket.get(playerId) ?? null;

        return Object.freeze({
            previousSocketId: stashed?.socketId ?? boundSocket,
            stashedRoomId: stashed?.roomId ?? null
        });

    }

    /**
     * Moves stashed recovery ownership to a new socket id.
     * Used by integration tests that simulate a page refresh with a new socket.
     * Production reclaim uses playerId claim via resolveRecoveryIdentity.
     */
    transferRecoveryOwnership(fromSocketId, toSocketId) {

        const identity = this._recoveryOwnershipBySocket.get(fromSocketId);

        if (!identity || !toSocketId) {

            return false;

        }

        this._recoveryOwnershipBySocket.delete(fromSocketId);

        this._recoveryOwnershipBySocket.set(toSocketId, identity);

        const byPlayer = this._recoveryOwnershipByPlayer.get(identity.playerId);

        if (byPlayer) {

            this._recoveryOwnershipByPlayer.set(identity.playerId, {
                roomId: identity.roomId,
                socketId: toSocketId
            });

        }

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

    _handleGameCreated({ gameId, roomId }) {

        if (!gameId || !roomId) {

            return;

        }

        // R1.1 — startGame (Page2 entry) fires at game prep / room-full,
        // not at GAME_INITIALIZED (which now waits for entry payment).
        this._deliverStartGame(roomId, gameId);

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

    }

    _deliverStartGame(roomId, gameId) {

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

        this._logger.info(
            `Lobby startGame delivered | roomId=${roomId} | gameId=${gameId}`
        );

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

        // C4.9 / R6.5 — Deliberate leave of a started room ends the session via
        // the single SESSION_FINISHED cleanup path (same as result-session timeout).
        // Soft disconnect never reaches here; recovery is untouched.
        if (gameStarted) {

            this._finishResultSession(roomId, "session_ended");

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

    /**
     * R6.5 — Single cleanup path for Page6 FINISH and Result Session timeout.
     * Broadcasts SESSION_FINISHED while sockets are still joined, then closes.
     */
    _finishResultSession(roomId, reason) {

        if (!roomId) {

            return;

        }

        if (this._finishingResultSessions.has(roomId)) {

            return;

        }

        const room = this._roomManager.getRoom(roomId);

        if (!room) {

            this._resultSessionLifecycle?.cancel(roomId);

            return;

        }

        this._finishingResultSessions.add(roomId);

        const activeSession = this._resultSessionLifecycle?.getSession(roomId);

        const gameId = activeSession?.gameId ?? null;

        this._resultSessionLifecycle?.cancel(roomId);

        this._eventBus.emit({
            source: EVENT_SOURCES.ROOM_LOBBY_BRIDGE,
            type: EVENT_TYPES.SESSION_FINISHED,
            payload: {
                roomId,
                gameId,
                reason,
                timestamp: Date.now()
            }
        });

        this._deliverToRoom(
            roomId,
            LOBBY_SERVER_EVENTS.SESSION_FINISHED,
            {
                roomId,
                gameId,
                reason,
                timestamp: Date.now()
            }
        );

        this._closeRoom(roomId, reason);

        this._finishingResultSessions.delete(roomId);

    }

    _handleResultSessionExpired(payload) {

        const roomId = payload?.roomId;

        if (!roomId) {

            return;

        }

        this._finishResultSession(
            roomId,
            payload?.reason ?? "result_session_expired"
        );

    }

    _closeRoom(roomId, reason) {

        const room = this._roomManager.getRoom(roomId);

        if (!room) {

            return;

        }

        const playerIds = [...room.players];

        this._resultSessionLifecycle?.cancel(roomId);

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

        const identity = this._playerManager.updateIdentity(playerId, {
            nickname: profile.nickname,
            age: profile.age,
            color: profile.color,
            colorSector2: profile.colorSector2,
            sectorCount: profile.sectorCount,
            sectorArrangement: profile.sectorArrangement,
            baseStake: profile.baseStake
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

        this._tryEmitAllPlayerProfilesReady(roomId);

    }

    /**
     * R5.15 / R5.17 — After all Page2 profiles exist, assign VERIFY icons once,
     * then notify GameManager so WHEEL_CONFIGURATION can be generated.
     */
    _tryEmitAllPlayerProfilesReady(roomId) {

        if (!roomId || this._allProfilesReadyByRoom.has(roomId)) {

            return;

        }

        const room = this._roomManager.getRoom(roomId);

        if (!room || room.players.length !== room.maxPlayers) {

            return;

        }

        if (!areRoomPage2ProfilesComplete(this._playerManager, room.players)) {

            return;

        }

        // R5.17 — VERIFY-phase icon assignment (once per room).
        this._assignVerifyIcons(roomId);

        if (!areRoomPlayerProfilesComplete(this._playerManager, room.players)) {

            this._logger.error(
                `VERIFY icons incomplete after assignment | roomId=${roomId}`
            );

            return;

        }

        this._allProfilesReadyByRoom.add(roomId);

        this._logger.info(
            `Lobby all player profiles ready | roomId=${roomId}`
        );

        this._eventBus.emit({
            source: EVENT_SOURCES.ROOM_LOBBY_BRIDGE,
            type: EVENT_TYPES.ALL_PLAYER_PROFILES_READY,
            payload: { roomId }
        });

    }

    /**
     * R5.17 — Assign one unique random catalog icon id per player during VERIFY.
     * Idempotent. Broadcasts PLAYER_UPDATE so Page3 displays the icons.
     */
    _assignVerifyIcons(roomId) {

        if (!roomId || this._verifyIconsAssignedByRoom.has(roomId)) {

            return;

        }

        const room = this._roomManager.getRoom(roomId);

        if (!room) {

            return;

        }

        const used = new Set(
            room.players
                .map((playerId) => this._playerManager.getIdentity(playerId)?.icon)
                .filter(Boolean)
        );

        const available = ICONS
            .map((entry) => entry.id)
            .filter((iconId) => !used.has(iconId));

        const shuffled = this._shuffleIconIds(available);

        let nextIndex = 0;

        for (const playerId of room.players) {

            const identity = this._playerManager.getIdentity(playerId);

            if (identity?.icon) {

                continue;

            }

            const iconId = shuffled[nextIndex]
                ?? ICONS[nextIndex % ICONS.length]?.id
                ?? null;

            nextIndex += 1;

            if (!iconId) {

                this._logger.error(
                    `VERIFY icon assignment failed | roomId=${roomId} | playerId=${playerId}`
                );

                continue;

            }

            used.add(iconId);

            this._playerManager.updateIdentity(playerId, { icon: iconId });

        }

        this._verifyIconsAssignedByRoom.add(roomId);

        this._broadcastVerifyIcons(roomId, room);

        this._logger.info(
            `VERIFY icons assigned | roomId=${roomId} | players=${room.players.length}`
        );

    }

    _broadcastVerifyIcons(roomId, room) {

        const profilesRevealed = this._profilesRevealedByRoom.has(roomId);

        for (const recipientId of room.players) {

            const recipientSocketId = this._playerToSocket.get(recipientId);

            if (!recipientSocketId) {

                continue;

            }

            for (const subjectId of room.players) {

                const identity = this._playerManager.getIdentity(subjectId);

                const reveal = profilesRevealed || subjectId === recipientId;

                this._deliverToSocket(
                    recipientSocketId,
                    LOBBY_SERVER_EVENTS.PLAYER_UPDATE,
                    this._mapIdentityToLobbyPlayer(identity, subjectId, { reveal })
                );

            }

        }

    }

    _shuffleIconIds(iconIds) {

        const pool = [...iconIds];

        for (let index = pool.length - 1; index > 0; index -= 1) {

            const swapIndex = Math.floor(Math.random() * (index + 1));

            const temporary = pool[index];

            pool[index] = pool[swapIndex];

            pool[swapIndex] = temporary;

        }

        return pool;

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

        // P6.1 — wallet is session data for this room only (never PlayerIdentity).
        this._sessionWalletStore.setWallet(roomId, playerId, wallet);

        // Private ack so reconnect / local mirror can restore the session wallet.
        this._deliverOwnWallet(socketId, playerId, roomId);

        let continued = this._continueToPaymentByRoom.get(roomId);

        if (!continued) {

            continued = new Set();

            this._continueToPaymentByRoom.set(roomId, continued);

        }

        // First successful submit joins the barrier; later submits before freeze
        // may replace the session wallet without re-entering the barrier.
        if (continued.has(playerId)) {

            this._logger.info(
                `Verify NEXT wallet updated | roomId=${roomId} | playerId=${playerId}`
            );

            return;

        }

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

    _deliverOwnWallet(socketId, playerId, roomId = null) {

        const resolvedRoomId = roomId
            ?? this._playerManager.getRuntime(playerId)?.roomId
            ?? null;

        const wallet = this._sessionWalletStore.getWallet(
            resolvedRoomId,
            playerId
        );

        if (!wallet) {

            return;

        }

        this._deliverToSocket(
            socketId,
            LOBBY_SERVER_EVENTS.PLAYER_UPDATE,
            {
                playerId,
                wallet
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

        // P6.2 — start wallet connection barrier (no payment simulation).
        this._createAndBroadcastWalletConnectionSession(roomId);

        // Keep EntryPaymentSession shell for DEBUG_START_GAME / later stages,
        // but do not auto-run TelegramWalletAdapter simulation.
        this._createEntryPaymentSessionShell(roomId);

    }

    _createAndBroadcastWalletConnectionSession(roomId) {

        if (this._walletConnectionByRoom.has(roomId)) {

            this._broadcastWalletConnectionSession(roomId);

            return;

        }

        const room = this._roomManager.getRoom(roomId);

        if (!room) {

            return;

        }

        const roster = room.players.map((playerId) => ({
            playerId,
            sessionWallet: this._sessionWalletStore.getWallet(roomId, playerId)
        }));

        const session = WalletConnectionSession.createInitial(roomId, roster);

        this._walletConnectionByRoom.set(roomId, session);

        this._broadcastWalletConnectionSession(roomId);

        this._logger.info(
            `Wallet connection session created | roomId=${roomId} | `
                + `players=${session.players.length}`
        );

    }

    _createEntryPaymentSessionShell(roomId) {

        if (this._entryPaymentByRoom.has(roomId)) {

            return;

        }

        const room = this._roomManager.getRoom(roomId);

        if (!room) {

            return;

        }

        const roster = room.players.map((playerId) => ({
            playerId,
            wallet: this._sessionWalletStore.getWallet(roomId, playerId)
        }));

        const session = EntryPaymentSession.createInitial(roomId, roster);

        this._entryPaymentByRoom.set(roomId, session);

        this._logger.info(
            `Entry payment session shell created | roomId=${roomId} | `
                + `players=${session.players.length}`
        );

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

            return {
                playerId,
                wallet: this._sessionWalletStore.getWallet(roomId, playerId)
            };

        });

        const session = EntryPaymentSession.createInitial(roomId, roster);

        this._entryPaymentByRoom.set(roomId, session);

        this._broadcastEntryPaymentSession(roomId);

        // Legacy simulation path retained for explicit callers only (not P6.2).
        this._entryPaymentLifecycle.start(roomId, session);

        this._logger.info(
            `Entry payment session created | roomId=${roomId} | `
                + `players=${session.players.length}`
        );

    }

    _handleWalletConnectStarted(socketId) {

        // R6.3 TEMP DEBUG — remove after runtime trace
        console.log("[R6.3 TRACE] _handleWalletConnectStarted", { socketId });

        const context = this._getSocketContext(socketId);

        if (!context) {

            // R6.3 TEMP DEBUG — remove after runtime trace
            console.log(
                "[R6.3 TRACE] EARLY RETURN | reason=no socket context",
                { socketId }
            );

            return;

        }

        const { playerId, roomId } = context;

        if (!this._paymentStageReadyByRoom.has(roomId)) {

            // R6.3 TEMP DEBUG — remove after runtime trace
            console.log(
                "[R6.3 TRACE] EARLY RETURN | reason=not payment stage",
                { roomId, playerId }
            );

            return;

        }

        const session = this._walletConnectionByRoom.get(roomId);

        if (!session) {

            // R6.3 TEMP DEBUG — remove after runtime trace
            console.log(
                "[R6.3 TRACE] EARLY RETURN | reason=no session",
                { roomId, playerId }
            );

            return;

        }

        if (!session.setConnecting(playerId)) {

            // R6.3 TEMP DEBUG — remove after runtime trace
            console.log(
                "[R6.3 TRACE] EARLY RETURN | reason=setConnecting failed",
                { roomId, playerId }
            );

            return;

        }

        // R6.3 TEMP DEBUG — remove after runtime trace
        console.log("[R6.3 TRACE] setConnecting OK → broadcasting", {
            roomId,
            playerId
        });

        this._broadcastWalletConnectionSession(roomId);

    }

    _handleWalletConnectReport(socketId, rawConnectedWallet) {

        const context = this._getSocketContext(socketId);

        if (!context) {

            // R6.3 TEMP DEBUG — remove after runtime trace
            console.log(
                "[R6.3 TRACE] EARLY RETURN | reason=no socket context",
                { socketId, rawConnectedWallet }
            );

            return;

        }

        const { playerId, roomId } = context;

        if (!this._paymentStageReadyByRoom.has(roomId)) {

            // R6.3 TEMP DEBUG — remove after runtime trace
            console.log(
                "[R6.3 TRACE] EARLY RETURN | reason=not payment stage",
                { roomId, playerId, rawConnectedWallet }
            );

            return;

        }

        const session = this._walletConnectionByRoom.get(roomId);

        if (!session) {

            // R6.3 TEMP DEBUG — remove after runtime trace
            console.log(
                "[R6.3 TRACE] EARLY RETURN | reason=no session",
                { roomId, playerId, rawConnectedWallet }
            );

            return;

        }

        const sessionWallet = this._sessionWalletStore.getWallet(
            roomId,
            playerId
        );

        const connectedWallet = canonicalizeTonWalletAddress(rawConnectedWallet);

        // R6.3 TEMP DEBUG — remove after runtime trace
        console.log("[R6.3 TRACE] _handleWalletConnectReport", {
            roomId,
            playerId,
            sessionWallet,
            rawConnectedWallet,
            canonicalConnectedWallet: connectedWallet
        });

        if (!connectedWallet) {

            // R6.3 TRACE — canonicalize failed; existing mismatch path
            console.log(
                "[R6.3 TRACE] EARLY RETURN | reason=connectedWallet == null after canonicalize",
                { roomId, playerId, rawConnectedWallet }
            );

            session.setAddressMismatch(playerId, null);

            this._broadcastWalletConnectionSession(roomId);

            return;

        }

        if (!sessionWalletsMatch(sessionWallet, connectedWallet)) {

            // R6.3 TEMP DEBUG — remove after runtime trace
            console.log(
                "[R6.3 TRACE] EARLY RETURN | reason=sessionWalletsMatch == false",
                { roomId, playerId, sessionWallet, connectedWallet }
            );

            session.setAddressMismatch(playerId, connectedWallet);

            this._broadcastWalletConnectionSession(roomId);

            this._logger.info(
                `Wallet address mismatch | roomId=${roomId} | playerId=${playerId}`
            );

            return;

        }

        // R6.3 TEMP DEBUG — remove after runtime trace
        console.log("[R6.3 TRACE] SETTING CONNECTED", {
            roomId,
            playerId,
            connectedWallet
        });

        session.setConnected(playerId, connectedWallet);

        // R6.3 TEMP DEBUG — remove after runtime trace
        console.log("[R6.3 TRACE] after setConnected", {
            session: session.toSnapshot(),
            allPlayerStatuses: session.players.map((p) => ({
                playerId: p.playerId,
                status: p.status
            })),
            paymentConnectionReady: session.paymentConnectionReady
        });

        this._broadcastWalletConnectionSession(roomId);

        if (session.paymentConnectionReady) {

            // R6.3 TEMP DEBUG — remove after runtime trace
            console.log("[R6.3 TRACE] PAYMENT_CONNECTION_READY EMITTED", {
                roomId
            });

            this._deliverPaymentConnectionReady(roomId);

        } else {

            // R6.3 TEMP DEBUG — remove after runtime trace
            console.log(
                "[R6.3 TRACE] EARLY RETURN | reason=paymentConnectionReady == false (not all CONNECTED)",
                {
                    roomId,
                    allPlayerStatuses: session.players.map((p) => ({
                        playerId: p.playerId,
                        status: p.status
                    }))
                }
            );

        }

    }

    _handleWalletDisconnectReport(socketId) {

        const context = this._getSocketContext(socketId);

        if (!context) {

            return;

        }

        const { playerId, roomId } = context;

        const session = this._walletConnectionByRoom.get(roomId);

        if (!session) {

            return;

        }

        if (!session.setWaiting(playerId)) {

            return;

        }

        this._broadcastWalletConnectionSession(roomId);

    }

    _broadcastWalletConnectionSession(roomId) {

        const session = this._walletConnectionByRoom.get(roomId);

        if (!session) {

            return;

        }

        this._deliverToRoom(
            roomId,
            LOBBY_SERVER_EVENTS.WALLET_CONNECTION_SESSION_UPDATED,
            session.toSnapshot()
        );

    }

    _deliverPaymentConnectionReady(roomId) {

        this._eventBus.emit({
            source: EVENT_SOURCES.ROOM_LOBBY_BRIDGE,
            type: EVENT_TYPES.PAYMENT_CONNECTION_READY,
            payload: { roomId, timestamp: Date.now() }
        });

        this._deliverToRoom(
            roomId,
            LOBBY_SERVER_EVENTS.PAYMENT_CONNECTION_READY,
            { roomId }
        );

        this._logger.info(`Payment connection ready | roomId=${roomId}`);

    }

    _deliverPaymentSessionCreated(payload) {

        const roomId = payload?.roomId;

        if (!roomId) {

            return;

        }

        this._deliverToRoom(
            roomId,
            LOBBY_SERVER_EVENTS.PAYMENT_SESSION_CREATED,
            payload
        );

    }

    _deliverPaymentSessionUpdated(payload) {

        const roomId = payload?.roomId;

        if (!roomId) {

            return;

        }

        this._deliverToRoom(
            roomId,
            LOBBY_SERVER_EVENTS.PAYMENT_SESSION_UPDATED,
            payload
        );

    }

    _deliverPaymentRequest(payload) {

        const roomId = payload?.roomId;

        const playerId = payload?.playerId;

        if (!roomId || !playerId) {

            return;

        }

        // Broadcast so every client sees every seat's request; key by playerId.
        this._deliverToRoom(
            roomId,
            LOBBY_SERVER_EVENTS.PAYMENT_REQUEST,
            payload
        );

    }

    _deliverPaymentSessionCompleted(payload) {

        const roomId = payload?.roomId;

        if (!roomId) {

            return;

        }

        this._deliverToRoom(
            roomId,
            LOBBY_SERVER_EVENTS.PAYMENT_SESSION_COMPLETED,
            payload
        );

    }

    _handlePaymentSessionFailed(payload) {

        const roomId = payload?.roomId;

        if (!roomId) {

            return;

        }

        this._deliverToRoom(
            roomId,
            LOBBY_SERVER_EVENTS.PAYMENT_SESSION_FAILED,
            payload
        );

        // Mirror setup expiry: cancel the room; game never starts.
        if (!this._roomManager.getRoom(roomId)) {

            this._paymentSessionManager?.destroySession(roomId);

            return;

        }

        this._closeRoom(roomId, payload?.reason ?? "payment_failed");

    }

    _handlePaymentConfirmIntent(socketId) {

        const context = this._getSocketContext(socketId);

        if (!context) {

            return;

        }

        const { playerId, roomId } = context;

        this._paymentSessionManager?.submitPlayerConfirmation(roomId, playerId);

    }

    _handlePaymentCancelIntent(socketId) {

        const context = this._getSocketContext(socketId);

        if (!context) {

            return;

        }

        const { playerId, roomId } = context;

        this._paymentSessionManager?.reportPlayerCancel(roomId, playerId);

    }

    _deliverGameContractUpdated(payload) {

        const roomId = payload?.roomId;

        if (!roomId) {

            return;

        }

        this._deliverToRoom(
            roomId,
            LOBBY_SERVER_EVENTS.GAME_CONTRACT_UPDATED,
            payload
        );

    }

    _deliverGameContractDeployed(payload) {

        const roomId = payload?.roomId;

        if (!roomId) {

            return;

        }

        this._deliverToRoom(
            roomId,
            LOBBY_SERVER_EVENTS.GAME_CONTRACT_DEPLOYED,
            payload
        );

    }

    _handleGameContractDeployFailed(payload) {

        const roomId = payload?.roomId;

        if (!roomId) {

            return;

        }

        this._deliverToRoom(
            roomId,
            LOBBY_SERVER_EVENTS.GAME_CONTRACT_DEPLOY_FAILED,
            payload
        );

        // PaymentSessionManager fails the session on the same EventBus event;
        // room cancellation follows PAYMENT_SESSION_FAILED.

    }

    _deliverGameStartAuthorized(payload) {

        const roomId = payload?.roomId;

        if (!roomId) {

            return;

        }

        this._deliverToRoom(
            roomId,
            LOBBY_SERVER_EVENTS.GAME_START_AUTHORIZED,
            payload
        );

    }

    _deliverGameInitializing(payload) {

        const roomId = payload?.roomId;

        if (!roomId) {

            return;

        }

        this._deliverToRoom(
            roomId,
            LOBBY_SERVER_EVENTS.GAME_INITIALIZING,
            payload
        );

    }

    /**
     * P6.7 — after validation succeeds, reuse ENTRY_PAYMENT_COMPLETED → OPEN_PAGE5.
     */
    _handleGameStartBootstrapReady(payload) {

        const roomId = payload?.roomId;

        if (!roomId) {

            return;

        }

        this._completeEntryPayment(roomId);

    }

    _handleGameStartFailed(payload) {

        const roomId = payload?.roomId;

        if (!roomId) {

            return;

        }

        this._logger.error(
            `Game start failed | roomId=${roomId} | `
                + `reason=${payload?.reason ?? "unknown"}`
        );

        if (!this._roomManager.getRoom(roomId)) {

            return;

        }

        // Cancel game; payment + audit records stay on the ledger.
        this._closeRoom(roomId, payload?.reason ?? "game_start_failed");

    }

    _deliverSettlementEvent(eventName, payload) {

        const roomId = payload?.roomId
            ?? (payload?.gameId
                ? this._gameplayContextResolver?.resolveRoomByGameId(payload.gameId)
                : null);

        if (!roomId || !eventName) {

            return;

        }

        // Never forward ownerWallet — strip any accidental field.
        const { ownerWallet: _omit, ...safePayload } = payload ?? {};

        this._deliverToRoom(roomId, eventName, safePayload);

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

        // R1.1 — notify GameManager to start physics / clock / READY phases.
        this._eventBus.emit({
            source: EVENT_SOURCES.ROOM_LOBBY_BRIDGE,
            type: EVENT_TYPES.ENTRY_PAYMENT_COMPLETED,
            payload: { roomId }
        });

        this._logger.info(`Entry payment completed | roomId=${roomId}`);

        // Lifecycle timers are finished; keep EntryPaymentSession until room
        // cleanup so late reconnect can still restore the final snapshot +
        // ENTRY_PAYMENT_COMPLETED.
        this._entryPaymentLifecycle.cancel(roomId);

        // R1.3D — production + debug share one Page5 open signal (after
        // ENTRY_PAYMENT_COMPLETED activation has run synchronously).
        this._deliverOpenPage5(roomId);

    }

    /**
     * R1.3D — Development-only shortcut past wallet / smart-contract simulation.
     * Reuses the same ENTRY_PAYMENT_COMPLETED → activation path as production.
     */
    _handleDebugStartGame(socketId) {

        if (!this._isDevelopment) {

            this._logger.error(
                `DEBUG_START_GAME rejected | socketId=${socketId} | reason=not_development`
            );

            return;

        }

        const playerId = this._socketToPlayer.get(socketId);

        if (!playerId) {

            this._logger.error(
                `DEBUG_START_GAME rejected | socketId=${socketId} | reason=no_player`
            );

            return;

        }

        const runtime = this._playerManager.getRuntime(playerId);

        const roomId = runtime?.roomId ?? null;

        if (!roomId || !this._roomManager.getRoom(roomId)) {

            this._logger.error(
                `DEBUG_START_GAME rejected | socketId=${socketId} | reason=no_room`
            );

            return;

        }

        this._logger.info(
            `DEBUG_START_GAME | roomId=${roomId} | playerId=${playerId}`
        );

        if (this._entryPaymentCompletedByRoom.has(roomId)) {

            this._deliverOpenPage5(roomId);

            return;

        }

        // R5.15 — Dev shortcut may skip Page2; seed any incomplete seats so
        // ConfigurationEngine never builds from null defaults.
        this._ensureDebugProfilesReady(roomId);

        this._completeEntryPayment(roomId);

    }

    /**
     * R5.15 / R5.17 — Development-only: fill incomplete Page2 fields, then
     * assign VERIFY icons so wheel configuration can build.
     */
    _ensureDebugProfilesReady(roomId) {

        const room = this._roomManager.getRoom(roomId);

        if (!room) {

            return;

        }

        const debugSetups = [
            {
                nickname: "Dev1",
                sectorCount: 2,
                color: "Orange",
                colorSector2: "Orange",
                sectorArrangement: "together",
                baseStake: 10
            },
            {
                nickname: "Dev2",
                sectorCount: 2,
                color: "Green",
                colorSector2: "Green",
                sectorArrangement: "together",
                baseStake: 10
            },
            {
                nickname: "Dev3",
                sectorCount: 1,
                color: "Red",
                colorSector2: null,
                sectorArrangement: "together",
                baseStake: 10
            }
        ];

        room.players.forEach((playerId, index) => {

            const identity = this._playerManager.getIdentity(playerId);

            if (isPage2ProfileComplete(identity)
                && isPlayerProfileComplete(identity)) {

                return;

            }

            const setup = debugSetups[index % debugSetups.length];

            this._playerManager.updateIdentity(playerId, {
                nickname: identity?.nickname ?? setup.nickname,
                age: identity?.age ?? 25,
                color: identity?.color ?? setup.color,
                colorSector2: identity?.sectorCount === 2
                    || (!identity?.sectorCount && setup.sectorCount === 2)
                    ? (identity?.colorSector2 ?? setup.colorSector2 ?? setup.color)
                    : (identity?.colorSector2 ?? null),
                sectorCount: identity?.sectorCount === 2 || identity?.sectorCount === 1
                    ? identity.sectorCount
                    : setup.sectorCount,
                sectorArrangement: identity?.sectorArrangement
                    ?? setup.sectorArrangement,
                baseStake: identity?.baseStake ?? setup.baseStake
            });

        });

        this._assignVerifyIcons(roomId);

        this._tryEmitAllPlayerProfilesReady(roomId);

    }

    _deliverOpenPage5(roomId) {

        if (!roomId) {

            return;

        }

        this._deliverToRoom(
            roomId,
            LOBBY_SERVER_EVENTS.OPEN_PAGE5,
            { roomId }
        );

    }

    _deliverOpenPage6({ gameId, roomId: payloadRoomId }) {

        const roomId = payloadRoomId
            ?? (gameId
                ? this._gameplayContextResolver?.resolveRoomByGameId(gameId)
                : null);

        if (!roomId) {

            return;

        }

        this._deliverToRoom(
            roomId,
            LOBBY_SERVER_EVENTS.OPEN_PAGE6,
            { roomId, gameId: gameId ?? null }
        );

        // R6.5 — start the authoritative Page6 linger (FINISH or timeout).
        this._resultSessionLifecycle?.start(roomId, {
            gameId: gameId ?? null
        });

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

        this._walletConnectionByRoom.delete(roomId);

        this._paymentSessionManager?.destroySession(roomId);

        this._gameContractManager?.destroyContract(roomId);

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

        this._allProfilesReadyByRoom.delete(roomId);

        this._verifyIconsAssignedByRoom.delete(roomId);

        this._continueToPaymentByRoom.delete(roomId);

        this._paymentStageReadyByRoom.delete(roomId);

        this._destroyEntryPaymentArtifacts(roomId);

        this._secretMatrixByRoom.delete(roomId);

        // P6.1 — destroy session wallets with the finished setup / result session.
        this._sessionWalletStore.clearRoom(roomId);

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

        const colorSector2 = typeof rawProfile.colorSector2 === "string"
            ? rawProfile.colorSector2.trim().slice(0, 32)
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
            colorSector2,
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

        // R5.17 — catalog id (not glyph). Prefer unused ids.
        const available = ICONS.find((entry) => !used.has(entry.id))
            ?? ICONS[0];

        return available.id;

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
     * Soft disconnect / reconnect while a Setup Session owns the room
     * (from SETUP_SESSION_STARTED through COMPLETED until EXPIRED) or while
     * Game Session has started (post Setup Session completion).
     *
     * Waiting lobby membership before Setup Session exists still uses hard
     * leave so creator disconnect can close an unfilled room — but Setup
     * Session is created atomically with the room, so protection begins
     * immediately at SETUP_SESSION_STARTED.
     *
     * Setup Session SYNC is delivered on reconnectSession when the session is
     * still recoverable; RecoveryEngine stays gameplay-only.
     */
    _isProtectedSession(roomId) {

        if (this._setupSessionLifecycle?.isRecoverable(roomId) === true) {

            return true;

        }

        return this._startedRooms.has(roomId);

    }

    /** P6.1 — test / report access to session-scoped wallets. */
    getSessionWallet(roomId, playerId) {

        return this._sessionWalletStore.getWallet(roomId, playerId);

    }

    clearSessionWallets(roomId) {

        this._sessionWalletStore.clearRoom(roomId);

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

    _denyRecoveryIdentity(reason, details = {}) {

        this._lastRecoveryDenial = Object.freeze({
            reason,
            details: Object.freeze({ ...details }),
            at: Date.now()
        });

    }

    /**
     * Fallback when soft-disconnect stash is missing but the server still
     * holds the disconnected seat (Socket.IO state-recovery / race edge).
     */
    _tryRuntimeSeatRecovery(claimedPlayerId, claimRoomId, socketId) {

        if (!claimedPlayerId || !socketId) {

            return null;

        }

        if (!this._playerManager.hasPlayer(claimedPlayerId)) {

            this._logger.info(
                `[R6.2A Recovery] authorization`
                + ` | check=runtime_seat_fallback`
                + ` | result=fail`
                + ` | reason=player_missing`
                + ` | playerId=${claimedPlayerId}`
                + ` | socket.id=${socketId}`
            );

            this._denyRecoveryIdentity(
                "Recovery identity is not authorized for this socket",
                { playerId: claimedPlayerId, socketId, cause: "player_missing" }
            );

            return null;

        }

        const runtime = this._playerManager.getRuntime(claimedPlayerId);

        const roomId = runtime?.roomId ?? null;

        if (!roomId) {

            this._logger.info(
                `[R6.2A Recovery] authorization`
                + ` | check=runtime_seat_fallback`
                + ` | result=fail`
                + ` | reason=no_runtime_room`
                + ` | playerId=${claimedPlayerId}`
                + ` | socket.id=${socketId}`
            );

            this._denyRecoveryIdentity(
                "Recovery identity is not authorized for this socket",
                { playerId: claimedPlayerId, socketId, cause: "no_runtime_room" }
            );

            return null;

        }

        if (claimRoomId && claimRoomId !== roomId) {

            this._logger.info(
                `[R6.2A Recovery] authorization`
                + ` | check=runtime_seat_fallback`
                + ` | result=fail`
                + ` | reason=claim_room_mismatch`
                + ` | claimRoomId=${claimRoomId}`
                + ` | runtimeRoomId=${roomId}`
                + ` | playerId=${claimedPlayerId}`
                + ` | socket.id=${socketId}`
            );

            this._denyRecoveryIdentity(
                "Recovery room claim does not match the server session",
                {
                    playerId: claimedPlayerId,
                    socketId,
                    claimRoomId,
                    runtimeRoomId: roomId
                }
            );

            return null;

        }

        const boundSocket = this._playerToSocket.get(claimedPlayerId);

        const connectionState = runtime?.connectionState ?? null;

        if (boundSocket && boundSocket !== socketId) {

            if (connectionState === CONNECTION_STATE.DISCONNECTED) {

                this._logger.info(
                    `[R6.2A Recovery] authorization`
                    + ` | check=runtime_seat_fallback`
                    + ` | result=pass`
                    + ` | action=clear_stale_binding`
                    + ` | boundSocket.id=${boundSocket}`
                    + ` | playerId=${claimedPlayerId}`
                    + ` | socket.id=${socketId}`
                );

                this._unregisterSocket(boundSocket);

            } else {

                this._logger.info(
                    `[R6.2A Recovery] authorization`
                    + ` | check=runtime_seat_fallback`
                    + ` | result=fail`
                    + ` | reason=player_bound_elsewhere`
                    + ` | boundSocket.id=${boundSocket}`
                    + ` | playerId=${claimedPlayerId}`
                    + ` | socket.id=${socketId}`
                );

                this._denyRecoveryIdentity(
                    "Recovery identity is not authorized for this socket",
                    {
                        playerId: claimedPlayerId,
                        socketId,
                        boundSocketId: boundSocket,
                        cause: "player_bound_elsewhere"
                    }
                );

                return null;

            }

        }

        const seatAvailable = connectionState === CONNECTION_STATE.DISCONNECTED
            || !boundSocket;

        if (!seatAvailable) {

            this._logger.info(
                `[R6.2A Recovery] authorization`
                + ` | check=runtime_seat_fallback`
                + ` | result=fail`
                + ` | reason=player_still_connected`
                + ` | connectionState=${connectionState ?? "null"}`
                + ` | playerId=${claimedPlayerId}`
                + ` | socket.id=${socketId}`
            );

            this._denyRecoveryIdentity(
                "Recovery identity is not authorized for this socket",
                {
                    playerId: claimedPlayerId,
                    socketId,
                    connectionState,
                    cause: "player_still_connected"
                }
            );

            return null;

        }

        if (!this._isRecoverableIdentity(claimedPlayerId, roomId)) {

            this._logger.info(
                `[R6.2A Recovery] authorization`
                + ` | check=runtime_seat_fallback`
                + ` | result=fail`
                + ` | reason=session_not_recoverable`
                + ` | roomId=${roomId}`
                + ` | playerId=${claimedPlayerId}`
                + ` | socket.id=${socketId}`
            );

            this._denyRecoveryIdentity(
                "Player session is not recoverable",
                { playerId: claimedPlayerId, roomId, socketId }
            );

            return null;

        }

        this._stashRecoveryOwnership(socketId, {
            playerId: claimedPlayerId,
            roomId
        });

        this._logger.info(
            `[R6.2A Recovery] authorization`
            + ` | check=runtime_seat_fallback`
            + ` | result=pass`
            + ` | roomId=${roomId}`
            + ` | playerId=${claimedPlayerId}`
            + ` | socket.id=${socketId}`
            + ` | connectionState=${connectionState ?? "null"}`
        );

        return {
            playerId: claimedPlayerId,
            roomId
        };

    }

    _stashRecoveryOwnership(socketId, { playerId, roomId }) {

        if (!socketId || !playerId || !roomId) {

            return;

        }

        this._recoveryOwnershipBySocket.set(socketId, {
            playerId,
            roomId
        });

        this._recoveryOwnershipByPlayer.set(playerId, {
            roomId,
            socketId
        });

    }

    _clearRecoveryOwnership(socketId) {

        if (!socketId) {

            return;

        }

        const stashed = this._recoveryOwnershipBySocket.get(socketId);

        this._recoveryOwnershipBySocket.delete(socketId);

        if (stashed?.playerId) {

            const byPlayer = this._recoveryOwnershipByPlayer.get(
                stashed.playerId
            );

            if (byPlayer?.socketId === socketId) {

                this._recoveryOwnershipByPlayer.delete(stashed.playerId);

            }

        }

    }

    _clearRecoveryOwnershipForPlayer(playerId) {

        if (!playerId) {

            return;

        }

        this._recoveryOwnershipByPlayer.delete(playerId);

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
