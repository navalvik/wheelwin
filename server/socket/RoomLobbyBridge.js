import { registerRoomDestroyContext } from "../diagnostics/RoomDestroyForensics.js";
import {
    logPaymentStageReady,
    logPaymentTransitionGate
} from "../diagnostics/PaymentTransitionForensics.js";
import { registerSetupStoragePaymentReady } from "../diagnostics/SetupSessionStorageForensics.js";
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
import {
    SECRET_MATRIX_STATUS,
    SECRET_MATRIX_STATUS_REASONS
} from "../models/SecretMatrixStatus.js";
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
    WALLET_CONNECTION_STATUS,
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
        lifecycleManager = null,
        roomConfig = null
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

        // R7.24 — post-ARCHIVED stage timers (wallet connection barrier).
        this._walletConnectionDurationMs = Number.isFinite(
            roomConfig?.walletConnectionDurationMs
        ) && roomConfig.walletConnectionDurationMs > 0
            ? roomConfig.walletConnectionDurationMs
            : 5 * 60 * 1000;

        // roomId → timeout handle
        this._walletConnectionTimersByRoom = new Map();

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

        // R7.5A — sockets that requested reclaim but are not yet authoritative.
        this._pendingSockets = new Map();

        // R7.5A — retired sockets after atomic commit (late packets logged/rejected).
        this._obsoleteSockets = new Map();

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

        // R6.8 — Read-only TonConnect diagnostic timeline (roomId → events[]).
        this._tonConnectEventsByRoom = new Map();

        // R6.8 — Per-player diagnostic timestamps (roomId → Map(playerId → meta)).
        this._tonConnectPlayerMetaByRoom = new Map();

        // R6.11E — Forensic TonConnect autopsy snapshots (roomId → store).
        this._tonConnectAutopsyByRoom = new Map();

        // Secret Matrix submissions keyed by roomId → Map(playerId → cells).
        this._secretMatrixByRoom = new Map();

        // R7.7A — monotonic revision per room for SECRET_MATRIX_STATUS.
        this._secretMatrixRevisionByRoom = new Map();

        // R7.7A — rooms that reached MATCH_ACCEPTED (until barrier clear).
        this._secretMatrixAcceptedByRoom = new Set();

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
            EVENT_TYPES.LOBBY_TONCONNECT_AUTOPSY_SNAPSHOT_REQUEST,
            (envelope) => {

                this._handleTonConnectAutopsySnapshot(
                    envelope.payload.socketId,
                    envelope.payload.payload,
                    {
                        roomId: envelope.payload.roomId ?? null,
                        playerId: envelope.payload.playerId ?? null
                    }
                );

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
                this._handleSocketDisconnected(
                    envelope.payload.socketId,
                    envelope.payload.reason ?? null
                );

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

        this._pendingSockets.clear();

        this._obsoleteSockets.clear();

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

        for (const roomId of [
            ...this._walletConnectionTimersByRoom.keys()
        ]) {

            this._clearWalletConnectionTimeout(roomId);

        }

        this._entryPaymentByRoom.clear();

        this._entryPaymentCompletedByRoom.clear();

        this._walletConnectionByRoom.clear();

        this._tonConnectEventsByRoom.clear();

        this._tonConnectPlayerMetaByRoom.clear();

        this._tonConnectAutopsyByRoom.clear();

        this._secretMatrixByRoom.clear();

        this._secretMatrixRevisionByRoom.clear();

        this._secretMatrixAcceptedByRoom.clear();

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

            registerRoomDestroyContext(room.roomId, {
                reason: "create_player_failed",
                caller: "RoomLobbyBridge._handleCreateRoom",
                triggerEvent: "CREATE_ROOM_PLAYER_FAILED",
                currentGameStage: "ROOM"
            });

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

            registerRoomDestroyContext(room.roomId, {
                reason: "add_player_failed",
                caller: "RoomLobbyBridge._handleCreateRoom",
                triggerEvent: "CREATE_ROOM_ADD_PLAYER_FAILED",
                currentGameStage: "ROOM"
            });

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

        this._logger.decisionTrace({
            stage: "JOIN_ROOM_REQUEST",
            decision: "RECEIVED",
            reason: `rawRoomId=${rawRoomId ?? "null"}`,
            caller: "RoomLobbyBridge._handleJoinRoom",
            nextAction: "Validate socket and room",
            roomId: typeof rawRoomId === "string" ? rawRoomId : null,
            socketId
        });

        if (this._socketToPlayer.has(socketId)) {

            this._logger.decisionTrace({
                stage: "JOIN_ROOM_VALIDATION",
                decision: "REJECT",
                reason: "Duplicate socket / PLAYER_ALREADY_CONNECTED",
                caller: "RoomLobbyBridge._handleJoinRoom",
                nextAction: "Emit roomError",
                roomId: typeof rawRoomId === "string" ? rawRoomId : null,
                socketId
            });

            this._emitRoomError(
                socketId,
                LOBBY_ERROR_CODES.PLAYER_ALREADY_CONNECTED
            );

            return;

        }

        const roomId = this._resolveRoomId(rawRoomId);

        if (!roomId) {

            const invalid = this._isInvalidRoomId(rawRoomId);
            const rejectCode = invalid
                ? LOBBY_ERROR_CODES.INVALID_ROOM_ID
                : LOBBY_ERROR_CODES.ROOM_NOT_FOUND;

            this._logger.decisionTrace({
                stage: "JOIN_ROOM_VALIDATION",
                decision: "REJECT",
                reason: invalid ? "Invalid room id format" : "Room not found",
                caller: "RoomLobbyBridge._handleJoinRoom",
                nextAction: "Emit roomError",
                roomId: typeof rawRoomId === "string" ? rawRoomId : null,
                socketId
            });

            this._emitRoomError(socketId, rejectCode);

            return;

        }

        const room = this._roomManager.getRoom(roomId);

        if (!room) {

            this._logger.decisionTrace({
                stage: "JOIN_ROOM_VALIDATION",
                decision: "REJECT",
                reason: "Room not found",
                caller: "RoomLobbyBridge._handleJoinRoom",
                nextAction: "Emit roomError",
                roomId,
                socketId
            });

            this._emitRoomError(socketId, LOBBY_ERROR_CODES.ROOM_NOT_FOUND);

            return;

        }

        if (room.status === ROOM_STATUS.LOCKED) {

            this._logger.decisionTrace({
                stage: "JOIN_ROOM_VALIDATION",
                decision: "REJECT",
                reason: "Room locked",
                caller: "RoomLobbyBridge._handleJoinRoom",
                nextAction: "Emit roomError",
                roomId,
                socketId
            });

            this._emitRoomError(socketId, LOBBY_ERROR_CODES.ROOM_LOCKED);

            return;

        }

        if (room.status === ROOM_STATUS.FULL
            || room.players.length >= room.maxPlayers) {

            this._logger.decisionTrace({
                stage: "JOIN_ROOM_VALIDATION",
                decision: "REJECT",
                reason: "Room full",
                caller: "RoomLobbyBridge._handleJoinRoom",
                nextAction: "Emit roomError",
                roomId,
                socketId
            });

            this._emitRoomError(socketId, LOBBY_ERROR_CODES.ROOM_FULL);

            return;

        }

        this._logger.decisionTrace({
            stage: "JOIN_ROOM_VALIDATION",
            decision: "PASS",
            reason: `Room joinable; players=${room.players.length}/${room.maxPlayers}`,
            caller: "RoomLobbyBridge._handleJoinRoom",
            nextAction: "Register player and add to room",
            roomId,
            socketId
        });

        const player = this._playerManager.createPlayer();

        if (!player) {

            this._logger.decisionTrace({
                stage: "JOIN_ROOM_VALIDATION",
                decision: "REJECT",
                reason: "Player creation failed",
                caller: "RoomLobbyBridge._handleJoinRoom",
                nextAction: "Emit roomError",
                roomId,
                socketId
            });

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

            let rejectReason = "Room full";
            let rejectCode = LOBBY_ERROR_CODES.ROOM_FULL;

            if (!latestRoom) {

                rejectReason = "Room not found";
                rejectCode = LOBBY_ERROR_CODES.ROOM_NOT_FOUND;

            } else if (latestRoom.status === ROOM_STATUS.LOCKED) {

                rejectReason = "Room locked";
                rejectCode = LOBBY_ERROR_CODES.ROOM_LOCKED;

            }

            this._logger.decisionTrace({
                stage: "JOIN_ROOM_VALIDATION",
                decision: "REJECT",
                reason: rejectReason,
                caller: "RoomLobbyBridge._handleJoinRoom",
                nextAction: "Emit roomError",
                roomId,
                playerId,
                socketId
            });

            this._emitRoomError(socketId, rejectCode);

            return;

        }

        this._playerManager.updateRuntime(playerId, {
            roomId
        });

        const roomSnapshot = this._roomManager.getRoom(roomId);
        const playerCount = roomSnapshot?.players.length ?? null;
        const maxPlayers = roomSnapshot?.maxPlayers ?? null;

        this._logger.decisionTrace({
            stage: "JOIN_ROOM_ACCEPTED",
            decision: "ACCEPT",
            reason: `Player registered; playerCount=${playerCount}/${maxPlayers}`,
            caller: "RoomLobbyBridge._handleJoinRoom",
            nextAction: "Broadcast lobby state",
            roomId,
            playerId,
            socketId
        });

        this._logger.decisionTrace({
            stage: "PLAYER_REGISTERED",
            decision: "SUCCESS",
            reason: `playerCount=${playerCount}/${maxPlayers}`,
            caller: "RoomLobbyBridge._handleJoinRoom",
            nextAction: "Broadcast Lobby State",
            roomId,
            playerId,
            socketId
        });

        this._logger.decisionTrace({
            stage: "ROOM_PLAYER_COUNT_UPDATED",
            decision: "UPDATE",
            reason: `playerCount=${playerCount}/${maxPlayers}`,
            caller: "RoomLobbyBridge._handleJoinRoom",
            nextAction: playerCount >= maxPlayers ? "ROOM_FULL" : "Wait for players",
            roomId,
            playerId,
            socketId
        });

        if (playerCount >= maxPlayers) {

            this._logger.decisionTrace({
                stage: "ROOM_FULL",
                decision: "FULL",
                reason: `playerCount=${playerCount}/${maxPlayers}`,
                caller: "RoomLobbyBridge._handleJoinRoom",
                nextAction: "VERIFY starts",
                roomId,
                playerId,
                socketId
            });

        }

        this._logger.info(
            `Lobby room joined | roomId=${roomId} | playerId=${playerId}`
        );

        this._emitPlayerJoined(roomId, playerId);

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

    _handleSocketDisconnected(socketId, disconnectReason = null) {

        const context = this._getSocketContext(socketId);

        const roomId = context?.roomId ?? null;
        const playerId = context?.playerId ?? null;

        const room = roomId ? this._roomManager.getRoom(roomId) ?? null : null;

        const walletConnection = roomId
            ? this._walletConnectionByRoom.get(roomId) ?? null
            : null;

        const paymentSession = roomId
            ? this._paymentSessionManager?.getSession?.(roomId) ?? null
            : null;

        const contract = roomId
            ? this._gameContractManager?.getContract?.(roomId) ?? null
            : null;

        const stage = roomId
            ? (this._paymentStageReadyByRoom.has(roomId)
                ? "PAYMENT"
                : this._profilesRevealedByRoom.has(roomId)
                    ? "VERIFY"
                    : "SETUP")
            : null;

        const protectedSession = roomId
            ? this._isProtectedSession(roomId)
            : null;

        const creatorId = roomId ? this._roomCreators.get(roomId) ?? null : null;

        const socketCount = room
            ? room.players
                .filter((pid) => Boolean(this._playerToSocket.get(pid)))
                .length
            : 0;

        const gameStarted = roomId ? this._startedRooms.has(roomId) : false;

        const creatorLeftCandidate = (
            Boolean(context)
            && creatorId === playerId
            && !gameStarted
        );

        const emptyRoomCandidate = (
            Boolean(context)
            && room
            && room.players.length === 1
            && room.status !== ROOM_STATUS.LOCKED
        );

        const willRemovePlayer = Boolean(
            context
            && protectedSession !== true
            && !creatorLeftCandidate
            && !gameStarted
            && room
            && room.status !== ROOM_STATUS.LOCKED
        );

        const willCloseRoom = Boolean(
            context
            && protectedSession !== true
            && (creatorLeftCandidate || gameStarted || emptyRoomCandidate)
        );

        console.log("======================================================");
        console.log("SOCKET DISCONNECT");
        console.log({
            Timestamp: new Date().toISOString(),
            RoomId: roomId,
            GameId: roomId
                ? this._gameplayContextResolver?.resolveGameIdByRoomId?.(roomId) ?? null
                : null,
            PlayerId: playerId ?? null,
            IdentityId: (() => {
                try {
                    return playerId
                        ? this._playerManager.getIdentity?.(playerId)?.identityId ?? null
                        : null;
                } catch {
                    return null;
                }
            })(),
            SocketId: socketId,
            PreviousSocketId: playerId
                ? this._playerToSocket.get(playerId) ?? null
                : null,
            ProtectedSession: protectedSession,
            CurrentStage: stage,
            WalletConnected: walletConnection?.paymentConnectionReady === true,
            PaymentSession: paymentSession
                ? {
                    paymentSessionId: paymentSession.paymentSessionId ?? null,
                    status: paymentSession.status ?? null
                }
                : null,
            DeployState: contract
                ? {
                    contractId: contract.contractId ?? null,
                    status: contract.status ?? null
                }
                : null,
            Creator: creatorId,
            RoomPlayerCount: room?.players.length ?? 0,
            RoomSocketCount: socketCount,
            DisconnectReason: disconnectReason ?? null,
            WillRemovePlayer: willRemovePlayer,
            WillCloseRoom: willCloseRoom,
            WillDestroyRoom: willCloseRoom
        });
        console.trace("RoomLobbyBridge._handleSocketDisconnected trace");
        console.log("======================================================");

        if (!context) {

            return;

        }

        if (this._isProtectedSession(context.roomId)) {

            this._logger.decisionTrace({
                stage: "SOCKET_DISCONNECT",
                decision: "IGNORE",
                reason: "Protected Session",
                caller: "RoomLobbyBridge._handleSocketDisconnected",
                nextAction: "Continue Game",
                roomId: context.roomId
            });

            // R7.5A — soft disconnect keeps authoritative ownership until commit.
            // Never _unregisterSocket here (that created the zero-owner gap).
            this._stashRecoveryOwnership(socketId, {
                playerId: context.playerId,
                roomId: context.roomId
            });

            this._playerManager.setConnectionState(
                context.playerId,
                CONNECTION_STATE.DISCONNECTED
            );

            // Stop broadcasts on the dead transport; maps stay authoritative.
            this._deliverSocketLeaveRoom(socketId);

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

        this._logger.decisionTrace({
            stage: "SOCKET_DISCONNECT",
            decision: "REMOVE_PLAYER",
            reason: "Unprotected Session",
            caller: "RoomLobbyBridge._handleSocketDisconnected",
            nextAction: "Remove player / possibly close room",
            roomId: context.roomId
        });

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

        const oldSocketId = this._playerToSocket.get(playerId) ?? null;

        this._markPendingSocket(socketId, playerId, roomId);

        const committed = this._commitSocketAuthority({
            playerId,
            roomId,
            oldSocketId: oldSocketId === socketId ? null : oldSocketId,
            newSocketId: socketId
        });

        if (!committed.ok) {

            this._clearPendingSocket(socketId);

            this._logger.info(
                `[R6.2A Recovery] reclaim failure`
                + ` | roomId=${roomId}`
                + ` | playerId=${playerId}`
                + ` | socket.id=${socketId}`
                + ` | reason=${committed.reason}`
            );

            return {
                ok: false,
                reason: committed.reason
            };

        }

        if (committed.oldSocketId) {

            this._requestForceDisconnect(committed.oldSocketId);

        }

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

        // R7.7A — restore Matrix submission status by playerId after commit.
        this._deliverSecretMatrixStatus(roomId, playerId, {
            reason: SECRET_MATRIX_STATUS_REASONS.RESTORED,
            logRestore: true
        });

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

                // R7.69B — GameEscrow is payment authority. Re-query chain and
                // re-deliver if seats change (missed confirmation / multi-player).
                // In-memory confirmed seats already show paid on first delivery
                // (browser refresh after live confirmation).
                if (
                    paymentSession.isInProgress?.()
                    && this._paymentSessionManager?.syncFromGameEscrow
                ) {

                    Promise.resolve(
                        this._paymentSessionManager.syncFromGameEscrow(roomId)
                    ).then((result) => {

                        if (
                            !result?.ok
                            || ((result.synced ?? 0) === 0
                                && (result.demoted ?? 0) === 0)
                        ) {

                            return;

                        }

                        const updated = this._paymentSessionManager
                            .getSession(roomId);

                        if (!updated) {

                            return;

                        }

                        this._deliverToSocket(
                            socketId,
                            LOBBY_SERVER_EVENTS.PAYMENT_SESSION_UPDATED,
                            updated.toSnapshot()
                        );

                        this._deliverToRoom(
                            roomId,
                            LOBBY_SERVER_EVENTS.PAYMENT_SESSION_UPDATED,
                            updated.toSnapshot()
                        );

                    }).catch((error) => {

                        this._logger?.warn?.(
                            `GameEscrow payment sync skipped on reconnect | `
                                + `roomId=${roomId} | ${error?.message ?? error}`
                        );

                    });

                }

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

        const runtime = this._playerManager.getRuntime(playerId);

        const roomId = runtime?.roomId ?? null;

        if (isSocketLive(boundSocket)) {

            // R7.5A — do not deny; mark pending and let reconnectSession commit.
            this._markPendingSocket(newSocketId, playerId, roomId);

            this._logger.info(
                `[R6.2A Recovery] authorization`
                + ` | check=prepare_stale_socket`
                + ` | result=transfer`
                + ` | reason=bound_socket_still_live`
                + ` | boundSocket.id=${boundSocket}`
                + ` | playerId=${playerId}`
                + ` | socket.id=${newSocketId}`
            );

            return {
                released: false,
                boundSocketId: boundSocket,
                transfer: true
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

        this._markPendingSocket(newSocketId, playerId, roomId);

        return {
            released: true,
            boundSocketId: boundSocket,
            transfer: true
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

            console.log("======================================================");
            console.log("SOCKET BRANCH: creator_left");
            console.log({
                Timestamp: new Date().toISOString(),
                RoomId: roomId,
                PlayerId: playerId,
                SocketId: socketId ?? null,
                CreatorId: creatorId ?? null,
                GameStarted: gameStarted,
                DisconnectReason: reason ?? null
            });
            console.trace("RoomLobbyBridge._removePlayerFromLobby creator_left trace");
            console.log("======================================================");

            this._closeRoom(roomId, "creator_left");

            return;

        }

        // C4.9 / R6.5 — Deliberate leave of a started room ends the session via
        // the single SESSION_FINISHED cleanup path (same as result-session timeout).
        // Soft disconnect never reaches here; recovery is untouched.
        if (gameStarted) {

            console.log("======================================================");
            console.log("SOCKET BRANCH: gameStarted (finishResultSession)");
            console.log({
                Timestamp: new Date().toISOString(),
                RoomId: roomId,
                PlayerId: playerId,
                SocketId: socketId ?? null,
                GameStarted: gameStarted,
                DisconnectReason: reason ?? null
            });
            console.trace("RoomLobbyBridge._removePlayerFromLobby gameStarted trace");
            console.log("======================================================");

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

            console.log("======================================================");
            console.log("SOCKET BRANCH: empty_room (destroyRoom)");
            console.log({
                Timestamp: new Date().toISOString(),
                RoomId: roomId,
                PlayerId: playerId,
                SocketId: socketId ?? null,
                RemainingPlayers: remainingRoom?.players.length ?? 0,
                DisconnectReason: reason ?? null
            });
            console.trace("RoomLobbyBridge._removePlayerFromLobby empty_room trace");
            console.log("======================================================");

            registerRoomDestroyContext(roomId, {
                reason: "empty_room",
                caller: "RoomLobbyBridge._removePlayerFromLobby",
                triggerEvent: "PLAYER_LEFT_EMPTY_ROOM",
                currentGameStage: this._paymentStageReadyByRoom.has(roomId)
                    ? "PAYMENT"
                    : "SETUP"
            });

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

        this._logger.decisionTrace({
            stage: "TERMINAL_SUCCESS",
            decision: "RESULT_FINISHED",
            reason: reason ?? "result_session_finished",
            caller: "RoomLobbyBridge._finishResultSession",
            nextAction: "ROOM_TERMINATION → _closeRoom",
            roomId,
            gameId
        });

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

        console.log("======================================================");
        console.log("ROOM CLOSED FROM SOCKET (RoomLobbyBridge._closeRoom)");
        console.log({
            Timestamp: new Date().toISOString(),
            RoomId: roomId,
            Reason: reason ?? null,
            CurrentStage: this._paymentStageReadyByRoom.has(roomId)
                ? "PAYMENT"
                : this._profilesRevealedByRoom.has(roomId)
                    ? "VERIFY"
                    : "SETUP",
            RoomPlayerCount: room?.players.length ?? 0,
            HasPaymentSession: Boolean(
                this._paymentSessionManager?.getSession?.(roomId)
            ),
            HasContract: Boolean(
                this._gameContractManager?.getContract?.(roomId)
            )
        });
        console.trace("RoomLobbyBridge._closeRoom trace");
        console.log("======================================================");

        if (!room) {

            return;

        }

        this._logger.decisionTrace({
            stage: "ROOM_CLOSE",
            decision: "CLOSE",
            reason: reason ?? "unspecified",
            caller: "RoomLobbyBridge._closeRoom",
            nextAction: "destroyRoom()",
            roomId
        });

        this._logger.decisionTrace({
            stage: "ROOM_TERMINATION",
            decision: "CLOSE",
            reason: reason ?? "unspecified",
            caller: "RoomLobbyBridge._closeRoom",
            nextAction: "destroyRoom()",
            roomId
        });

        this._clearWalletConnectionTimeout(roomId);

        const playerIds = [...room.players];

        this._resultSessionLifecycle?.cancel(roomId);

        const gameId = this._gameplayContextResolver?.resolveGameIdByRoomId?.(roomId)
            ?? null;

        const walletConnection = this._walletConnectionByRoom.get(roomId);

        const paymentSession = this._paymentSessionManager?.getSession?.(roomId)
            ?? null;

        const setupSnapshot = this._setupSessionLifecycle?.buildSyncPayload?.(roomId)
            ?? null;

        registerRoomDestroyContext(roomId, {
            reason: reason ?? "unspecified",
            caller: "RoomLobbyBridge._closeRoom",
            triggerEvent: reason ?? "ROOM_CLOSE",
            gameId,
            currentGameStage: this._paymentStageReadyByRoom.has(roomId)
                ? "PAYMENT"
                : this._profilesRevealedByRoom.has(roomId)
                    ? "VERIFY"
                    : "SETUP",
            setupSession: setupSnapshot?.state ?? null,
            walletConnectionSession: walletConnection
                ? {
                    paymentConnectionReady: walletConnection.paymentConnectionReady === true,
                    players: walletConnection.players?.map((seat) => ({
                        playerId: seat.playerId,
                        status: seat.status
                    })) ?? []
                }
                : null,
            paymentSession: paymentSession
                ? {
                    paymentSessionId: paymentSession.paymentSessionId ?? null,
                    status: paymentSession.status ?? null
                }
                : null,
            socketCount: playerIds.filter(
                (playerId) => Boolean(this._playerToSocket.get(playerId))
            ).length
        });

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

        const context = this._assertAuthoritativeMutation(
            socketId,
            "updatePlayerProfile"
        );

        if (!context) {

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

        if (!this._isAuthoritativeSocket(socketId)) {

            this._emitUnauthorizedMatrixStatus(socketId);

            return;

        }

        const context = this._getSocketContext(socketId);

        if (!context) {

            this._emitUnauthorizedMatrixStatus(socketId);

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

            this._deliverSecretMatrixStatus(roomId, playerId, {
                reason: SECRET_MATRIX_STATUS_REASONS.INVALID_SECRET_MATRIX
            });

            return;

        }

        if (this._secretMatrixAcceptedByRoom.has(roomId)) {

            this._deliverSecretMatrixStatus(roomId, playerId, {
                reason: SECRET_MATRIX_STATUS_REASONS.MATCH_ACCEPTED
            });

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

            this._broadcastSecretMatrixStatus(
                roomId,
                SECRET_MATRIX_STATUS_REASONS.SUBMITTED
            );

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

            this._broadcastSecretMatrixStatus(
                roomId,
                SECRET_MATRIX_STATUS_REASONS.SECRET_MATRIX_MISMATCH,
                { forceStatus: SECRET_MATRIX_STATUS.MATCH_REJECTED }
            );

            this._broadcastSecretMatrixStatus(
                roomId,
                SECRET_MATRIX_STATUS_REASONS.SECRET_MATRIX_MISMATCH
            );

            return;

        }

        this._secretMatrixByRoom.delete(roomId);

        this._secretMatrixAcceptedByRoom.add(roomId);

        this._deliverToRoom(
            roomId,
            LOBBY_SERVER_EVENTS.SECRET_MATRIX_ACCEPTED,
            { roomId }
        );

        this._logger.info(`Secret Matrix accepted | roomId=${roomId}`);

        this._broadcastSecretMatrixStatus(
            roomId,
            SECRET_MATRIX_STATUS_REASONS.MATCH_ACCEPTED,
            { forceStatus: SECRET_MATRIX_STATUS.MATCH_ACCEPTED }
        );

    }

    /**
     * R7.7A — Authoritative Matrix status for one player (keyed by playerId).
     */
    getSecretMatrixStatus(roomId, playerId) {

        const room = roomId ? this._roomManager.getRoom(roomId) : null;

        const requiredPlayers = room?.players?.length ?? 0;

        const submissions = this._secretMatrixByRoom.get(roomId);

        const submittedCount = submissions?.size ?? 0;

        const selfSubmitted = Boolean(
            playerId && submissions?.has(playerId)
        );

        const revision = this._secretMatrixRevisionByRoom.get(roomId) ?? 0;

        let status = SECRET_MATRIX_STATUS.NOT_SUBMITTED;

        if (this._secretMatrixAcceptedByRoom.has(roomId)) {

            status = SECRET_MATRIX_STATUS.MATCH_ACCEPTED;

        } else if (selfSubmitted) {

            status = SECRET_MATRIX_STATUS.SUBMITTED;

        }

        return {
            roomId: roomId ?? null,
            playerId: playerId ?? null,
            status,
            submittedCount,
            requiredPlayers,
            selfSubmitted,
            reason: null,
            revision
        };

    }

    _bumpSecretMatrixRevision(roomId) {

        if (!roomId) {

            return 0;

        }

        const next = (this._secretMatrixRevisionByRoom.get(roomId) ?? 0) + 1;

        this._secretMatrixRevisionByRoom.set(roomId, next);

        return next;

    }

    _isAuthoritativeSocket(socketId) {

        if (!socketId) {

            return false;

        }

        if (this._obsoleteSockets.has(socketId)) {

            return false;

        }

        if (this._pendingSockets.has(socketId)) {

            return false;

        }

        return Boolean(this._getSocketContext(socketId));

    }

    _emitUnauthorizedMatrixStatus(socketId) {

        const pending = this._pendingSockets.get(socketId);

        const obsolete = this._obsoleteSockets.get(socketId);

        const meta = pending ?? obsolete ?? null;

        const context = this._getSocketContext(socketId);

        const playerId = meta?.playerId
            ?? context?.playerId
            ?? null;

        const roomId = meta?.roomId
            ?? context?.roomId
            ?? null;

        this._logger.info(
            `SOCKET_PENDING_PACKET`
            + ` | socketId=${socketId}`
            + ` | playerId=${playerId ?? "null"}`
            + ` | roomId=${roomId ?? "null"}`
            + ` | event=submitSecretMatrix`
            + ` | reason=SOCKET_NOT_AUTHORIZED`
        );

        if (obsolete) {

            this._logger.info(
                `SOCKET_OBSOLETE_PACKET`
                + ` | socketId=${socketId}`
                + ` | playerId=${playerId ?? "null"}`
                + ` | roomId=${roomId ?? "null"}`
                + ` | event=submitSecretMatrix`
                + ` | reason=obsolete_socket`
            );

        }

        if (roomId && playerId) {

            this._deliverSecretMatrixStatus(roomId, playerId, {
                reason: SECRET_MATRIX_STATUS_REASONS.SOCKET_NOT_AUTHORIZED,
                forceStatus: SECRET_MATRIX_STATUS.NOT_SUBMITTED,
                socketId
            });

            return;

        }

        const revision = roomId
            ? this._bumpSecretMatrixRevision(roomId)
            : 0;

        this._deliverToSocket(
            socketId,
            LOBBY_SERVER_EVENTS.SECRET_MATRIX_STATUS,
            {
                roomId,
                playerId,
                status: SECRET_MATRIX_STATUS.NOT_SUBMITTED,
                submittedCount: 0,
                requiredPlayers: 0,
                selfSubmitted: false,
                reason: SECRET_MATRIX_STATUS_REASONS.SOCKET_NOT_AUTHORIZED,
                revision
            }
        );

    }

    _deliverSecretMatrixStatus(
        roomId,
        playerId,
        {
            reason = null,
            forceStatus = null,
            socketId = null,
            logRestore = false,
            bumpRevision = true
        } = {}
    ) {

        if (!roomId || !playerId) {

            return null;

        }

        if (bumpRevision) {

            this._bumpSecretMatrixRevision(roomId);

        }

        const payload = this.getSecretMatrixStatus(roomId, playerId);

        if (forceStatus) {

            payload.status = forceStatus;

            if (forceStatus === SECRET_MATRIX_STATUS.NOT_SUBMITTED) {

                payload.selfSubmitted = false;

            }

            if (forceStatus === SECRET_MATRIX_STATUS.MATCH_ACCEPTED) {

                payload.selfSubmitted = true;

            }

            if (forceStatus === SECRET_MATRIX_STATUS.MATCH_REJECTED) {

                payload.selfSubmitted = false;

            }

        }

        if (reason) {

            payload.reason = reason;

        }

        const targetSocketId = socketId
            ?? this._playerToSocket.get(playerId)
            ?? null;

        if (!targetSocketId) {

            return payload;

        }

        this._logger.info(
            `SECRET_MATRIX_STATUS_CHANGED`
            + ` | roomId=${roomId}`
            + ` | playerId=${playerId}`
            + ` | status=${payload.status}`
            + ` | revision=${payload.revision}`
            + ` | reason=${payload.reason ?? "null"}`
        );

        if (logRestore) {

            this._logger.info(
                `SECRET_MATRIX_STATUS_RESTORED`
                + ` | roomId=${roomId}`
                + ` | playerId=${playerId}`
                + ` | status=${payload.status}`
                + ` | revision=${payload.revision}`
            );

        }

        this._deliverToSocket(
            targetSocketId,
            LOBBY_SERVER_EVENTS.SECRET_MATRIX_STATUS,
            payload
        );

        return payload;

    }

    _broadcastSecretMatrixStatus(roomId, reason = null, options = {}) {

        const room = this._roomManager.getRoom(roomId);

        if (!room) {

            return;

        }

        this._bumpSecretMatrixRevision(roomId);

        for (const playerId of room.players) {

            this._deliverSecretMatrixStatus(roomId, playerId, {
                reason,
                forceStatus: options.forceStatus ?? null,
                bumpRevision: false
            });

        }

    }

    _handleConfirmVerify(socketId) {

        const context = this._assertAuthoritativeMutation(
            socketId,
            "confirmVerify"
        );

        if (!context) {

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

        const context = this._assertAuthoritativeMutation(
            socketId,
            "VERIFY_NEXT_REQUEST"
        );

        if (!context) {

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

        const setupSession = this._setupSessionLifecycle?.getSession(roomId) ?? null;

        const recoverable = this._setupSessionLifecycle?.isRecoverable(roomId) ?? false;

        const room = this._roomManager.getRoom(roomId);

        const continued = this._continueToPaymentByRoom.get(roomId);

        const verifiedCount = continued?.size ?? 0;

        const walletReady = room
            ? room.players.every((playerId) => Boolean(
                this._sessionWalletStore.getWallet(roomId, playerId)
            ))
            : false;

        logPaymentTransitionGate({
            roomId,
            currentStage: this._profilesRevealedByRoom.has(roomId)
                ? "VERIFY_COMPLETE"
                : "PRE_VERIFY",
            setupExists: Boolean(setupSession),
            setupState: setupSession?.state ?? null,
            recoverable,
            archiveForPaymentResult: "pending",
            roomExists: Boolean(room),
            roomDestroying: room?.status === "DESTROYED",
            verifiedPlayers: room
                ? `${verifiedCount}/${room.players.length}`
                : `${verifiedCount}/unknown`,
            walletReady,
            willEmitPaymentStageReady: true,
            caller: "RoomLobbyBridge._broadcastPaymentStageReady"
        });

        this._paymentStageReadyByRoom.add(roomId);

        registerSetupStoragePaymentReady(roomId);

        // R6.38 — Setup permanently relinquishes timer + destroy authority.
        // Payment lifecycle is the sole room owner from this boundary onward.
        const archivedSetup = this._setupSessionLifecycle
            ?.archiveForPayment?.(roomId)
            ?? null;

        const archiveResult = archivedSetup?.state
            ?? (archivedSetup ? "snapshot" : "null");

        this._logger.decisionTrace({
            stage: "PAYMENT_STAGE_READY",
            decision: archivedSetup ? "ALLOW" : "ALLOW_WITHOUT_ARCHIVE",
            reason: archivedSetup
                ? "Transition gate passed; Setup archived."
                : `Transition gate passed; archiveForPayment returned ${archiveResult}.`,
            caller: "RoomLobbyBridge._broadcastPaymentStageReady",
            nextAction: "Wallet Connection",
            roomId
        });

        logPaymentStageReady({
            roomId,
            archiveForPaymentResult: archiveResult,
            setupState: this._setupSessionLifecycle?.getSession(roomId)?.state
                ?? setupSession?.state
                ?? null,
            recoverable: this._setupSessionLifecycle?.isRecoverable(roomId) ?? false,
            currentStage: "PAYMENT_STAGE_READY",
            roomDestroying: this._roomManager.getRoom(roomId)?.status === "DESTROYED",
            emissionTarget: "room"
        });

        this._deliverToRoom(
            roomId,
            LOBBY_SERVER_EVENTS.PAYMENT_STAGE_READY,
            { roomId }
        );

        if (archivedSetup) {

            this._deliverToRoom(
                roomId,
                LOBBY_SERVER_EVENTS.SETUP_SESSION_SYNC,
                archivedSetup
            );

            this._logger.decisionTrace({
                stage: "SETUP_SESSION_SYNC",
                decision: "EMIT",
                reason: "Archived Setup snapshot delivered to room.",
                caller: "RoomLobbyBridge._broadcastPaymentStageReady",
                nextAction: "Wallet Connection",
                roomId
            });

        } else {

            this._logger.decisionTrace({
                stage: "SETUP_SESSION_SYNC",
                decision: "SKIP",
                reason: "archiveForPayment returned null; SETUP_SESSION_SYNC not emitted.",
                caller: "RoomLobbyBridge._broadcastPaymentStageReady",
                nextAction: "Wallet Connection",
                roomId
            });

        }

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

        this._tonConnectEventsByRoom.set(roomId, []);

        this._tonConnectPlayerMetaByRoom.set(roomId, new Map());

        this._tonConnectAutopsyByRoom.set(roomId, {
            latest: null,
            byPlayer: new Map()
        });

        this._scheduleWalletConnectionTimeout(roomId);

        console.log("[TonConnect TRACE] handshake transition", {
            old: null,
            next: "WAITING",
            stage: "WAITING",
            roomId,
            reason: "WALLET_CONNECTION_SESSION_CREATED",
            playerCount: session.players.length,
            timestamp: Date.now()
        });

        this._recordTonConnectEvent(roomId, {
            type: "WALLET_CONNECTION_SESSION_CREATED",
            playerId: null
        });

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

        console.log("[TonConnect TRACE] _handleWalletConnectStarted", {
            event: "WALLET_CONNECT_STARTED",
            socketId,
            timestamp: Date.now()
        });

        const context = this._getSocketContext(socketId);

        if (!context) {

            console.log("[TonConnect TRACE] handshake transition REJECTED", {
                old: null,
                requested: "CONNECTING",
                reason: "no_socket_context",
                socketId,
                timestamp: Date.now()
            });

            return;

        }

        const { playerId, roomId } = context;

        console.log("[TonConnect TRACE] incoming wallet handler context", {
            event: "WALLET_CONNECT_STARTED",
            socketId,
            playerId,
            roomId,
            payload: null,
            timestamp: Date.now()
        });

        if (!this._paymentStageReadyByRoom.has(roomId)) {

            console.log("[TonConnect TRACE] handshake transition REJECTED", {
                old: null,
                requested: "CONNECTING",
                reason: "not_payment_stage",
                roomId,
                playerId,
                socketId,
                timestamp: Date.now()
            });

            return;

        }

        const session = this._walletConnectionByRoom.get(roomId);

        if (!session) {

            console.log("[TonConnect TRACE] handshake transition REJECTED", {
                old: null,
                requested: "CONNECTING",
                reason: "no_wallet_connection_session",
                roomId,
                playerId,
                socketId,
                timestamp: Date.now()
            });

            return;

        }

        const seat = session.findPlayer(playerId);

        const oldStatus = seat?.status ?? null;

        if (!session.setConnecting(playerId)) {

            console.log("[TonConnect TRACE] handshake transition REJECTED", {
                old: oldStatus,
                requested: "CONNECTING",
                reason: !seat
                    ? "no_seat"
                    : session.paymentConnectionReady
                        ? "payment_connection_already_ready"
                        : "setConnecting_failed",
                roomId,
                playerId,
                socketId,
                paymentConnectionReady: session.paymentConnectionReady,
                timestamp: Date.now()
            });

            return;

        }

        console.log("[TonConnect TRACE] handshake transition", {
            old: oldStatus,
            next: "CONNECTING",
            stage: "CONNECTING",
            roomId,
            playerId,
            socketId,
            timestamp: Date.now()
        });

        this._touchTonConnectPlayerMeta(roomId, playerId, {
            lastStatusChangeAt: Date.now(),
            lastEvent: "WALLET_CONNECT_STARTED"
        });

        this._recordTonConnectEvent(roomId, {
            type: "WALLET_CONNECT_STARTED",
            playerId
        });

        this._broadcastWalletConnectionSession(roomId);

    }

    _handleWalletConnectReport(socketId, rawConnectedWallet) {

        const context = this._getSocketContext(socketId);

        if (!context) {

            console.log("[TonConnect TRACE] handshake transition REJECTED", {
                old: null,
                requested: "CONNECTED",
                reason: "no_socket_context",
                socketId,
                payload: { connectedWallet: rawConnectedWallet },
                timestamp: Date.now()
            });

            return;

        }

        const { playerId, roomId } = context;

        console.log("[TonConnect TRACE] incoming wallet handler context", {
            event: "WALLET_CONNECT_REPORT",
            socketId,
            playerId,
            roomId,
            payload: { connectedWallet: rawConnectedWallet },
            timestamp: Date.now()
        });

        if (!this._paymentStageReadyByRoom.has(roomId)) {

            console.log("[TonConnect TRACE] handshake transition REJECTED", {
                old: null,
                requested: "CONNECTED",
                reason: "not_payment_stage",
                roomId,
                playerId,
                socketId,
                timestamp: Date.now()
            });

            return;

        }

        const session = this._walletConnectionByRoom.get(roomId);

        if (!session) {

            console.log("[TonConnect TRACE] handshake transition REJECTED", {
                old: null,
                requested: "CONNECTED",
                reason: "no_wallet_connection_session",
                roomId,
                playerId,
                socketId,
                timestamp: Date.now()
            });

            return;

        }

        const seat = session.findPlayer(playerId);

        const oldStatus = seat?.status ?? null;

        const sessionWallet = this._sessionWalletStore.getWallet(
            roomId,
            playerId
        );

        const connectedWallet = canonicalizeTonWalletAddress(rawConnectedWallet);

        console.log("[TonConnect TRACE] _handleWalletConnectReport", {
            roomId,
            playerId,
            socketId,
            oldStatus,
            sessionWallet,
            rawConnectedWallet,
            canonicalConnectedWallet: connectedWallet,
            timestamp: Date.now()
        });

        if (!connectedWallet) {

            console.log("[TonConnect TRACE] handshake transition", {
                old: oldStatus,
                next: "ADDRESS_MISMATCH",
                stage: "ADDRESS_MISMATCH",
                reason: "connectedWallet_null_after_canonicalize",
                roomId,
                playerId,
                socketId,
                timestamp: Date.now()
            });

            session.setAddressMismatch(playerId, null);

            this._touchTonConnectPlayerMeta(roomId, playerId, {
                lastStatusChangeAt: Date.now(),
                lastReportAt: Date.now(),
                lastEvent: "REPORT_INVALID_WALLET"
            });

            this._recordTonConnectEvent(roomId, {
                type: "REPORT_RECEIVED",
                playerId,
                detail: "invalid_wallet"
            });

            this._broadcastWalletConnectionSession(roomId);

            return;

        }

        if (!sessionWalletsMatch(sessionWallet, connectedWallet)) {

            console.log("[TonConnect TRACE] handshake transition", {
                old: oldStatus,
                next: "ADDRESS_MISMATCH",
                stage: "ADDRESS_MISMATCH",
                reason: "session_wallet_mismatch",
                roomId,
                playerId,
                socketId,
                sessionWallet,
                connectedWallet,
                timestamp: Date.now()
            });

            session.setAddressMismatch(playerId, connectedWallet);

            this._logger.decisionTrace({
                stage: "WALLET_CONNECT_REPORT",
                decision: "ADDRESS_MISMATCH",
                reason: "Connected SDK wallet does not match VERIFY session wallet.",
                caller: "RoomLobbyBridge._handleWalletConnectReport",
                nextAction: "Require disconnect then connect correct wallet",
                roomId,
                playerId,
                oldStatus,
                nextStatus: WALLET_CONNECTION_STATUS.ADDRESS_MISMATCH
            });

            this._touchTonConnectPlayerMeta(roomId, playerId, {
                lastStatusChangeAt: Date.now(),
                lastReportAt: Date.now(),
                lastEvent: "ADDRESS_MISMATCH"
            });

            this._recordTonConnectEvent(roomId, {
                type: "ADDRESS_MISMATCH",
                playerId
            });

            this._broadcastWalletConnectionSession(roomId);

            this._logger.info(
                `Wallet address mismatch | roomId=${roomId} | playerId=${playerId}`
            );

            return;

        }

        console.log("[TonConnect TRACE] handshake transition", {
            old: oldStatus,
            next: "CONNECTED",
            stage: "CONNECTED",
            roomId,
            playerId,
            socketId,
            connectedWallet,
            timestamp: Date.now()
        });

        session.setConnected(playerId, connectedWallet);

        // R7.26 — restored SDK sessions report WAITING → CONNECTED without
        // an intermediate CONNECTING seat transition.
        this._logger.decisionTrace({
            stage: "WALLET_CONNECT_REPORT",
            decision: oldStatus === WALLET_CONNECTION_STATUS.WAITING
                || oldStatus == null
                ? "SERVER_SYNCHRONIZED"
                : "ALLOW",
            reason: oldStatus === WALLET_CONNECTION_STATUS.WAITING
                || oldStatus == null
                ? "SDK wallet synchronized without CONNECTING (restored session)."
                : `Wallet connect report accepted from ${oldStatus}.`,
            caller: "RoomLobbyBridge._handleWalletConnectReport",
            nextAction: session.paymentConnectionReady
                ? "Deliver PAYMENT_CONNECTION_READY"
                : "Await remaining wallet connections",
            roomId,
            playerId,
            oldStatus,
            nextStatus: WALLET_CONNECTION_STATUS.CONNECTED
        });

        this._touchTonConnectPlayerMeta(roomId, playerId, {
            lastStatusChangeAt: Date.now(),
            lastReportAt: Date.now(),
            lastEvent: "CONNECTED"
        });

        this._recordTonConnectEvent(roomId, {
            type: "REPORT_RECEIVED",
            playerId
        });

        this._recordTonConnectEvent(roomId, {
            type: "CONNECTED",
            playerId
        });

        console.log("[TonConnect TRACE] after setConnected", {
            session: session.toSnapshot(),
            allPlayerStatuses: session.players.map((p) => ({
                playerId: p.playerId,
                status: p.status
            })),
            paymentConnectionReady: session.paymentConnectionReady,
            timestamp: Date.now()
        });

        this._broadcastWalletConnectionSession(roomId);

        if (session.paymentConnectionReady) {

            console.log("[TonConnect TRACE] handshake transition", {
                old: "CONNECTED",
                next: "PAYMENT_READY",
                stage: "PAYMENT_READY",
                roomId,
                playerId,
                socketId,
                timestamp: Date.now()
            });

            this._recordTonConnectEvent(roomId, {
                type: "PAYMENT_READY",
                playerId: null
            });

            // R7.50 temporary diagnostics — PAYMENT_READY → PaymentSession pipeline.
            console.log("[R7.50 DIAG] PAYMENT_READY received", {
                roomId,
                playerId,
                paymentConnectionReady: session.paymentConnectionReady === true,
                next: "_deliverPaymentConnectionReady → EventBus PAYMENT_CONNECTION_READY",
                timestamp: Date.now()
            });

            this._deliverPaymentConnectionReady(roomId);

        } else {

            console.log("[TonConnect TRACE] PAYMENT_READY not reached", {
                reason: "not_all_players_CONNECTED",
                roomId,
                playerId,
                allPlayerStatuses: session.players.map((p) => ({
                    playerId: p.playerId,
                    status: p.status
                })),
                timestamp: Date.now()
            });

        }

    }

    _handleWalletDisconnectReport(socketId) {

        const context = this._getSocketContext(socketId);

        if (!context) {

            console.log("[TonConnect TRACE] handshake transition REJECTED", {
                old: null,
                requested: "WAITING",
                reason: "no_socket_context",
                socketId,
                timestamp: Date.now()
            });

            return;

        }

        const { playerId, roomId } = context;

        console.log("[TonConnect TRACE] incoming wallet handler context", {
            event: "WALLET_DISCONNECT_REPORT",
            socketId,
            playerId,
            roomId,
            payload: null,
            timestamp: Date.now()
        });

        const session = this._walletConnectionByRoom.get(roomId);

        if (!session) {

            console.log("[TonConnect TRACE] handshake transition REJECTED", {
                old: null,
                requested: "WAITING",
                reason: "no_wallet_connection_session",
                roomId,
                playerId,
                socketId,
                timestamp: Date.now()
            });

            return;

        }

        const seat = session.findPlayer(playerId);

        const oldStatus = seat?.status ?? null;

        if (!session.setWaiting(playerId)) {

            console.log("[TonConnect TRACE] handshake transition REJECTED", {
                old: oldStatus,
                requested: "WAITING",
                reason: !seat ? "no_seat" : "setWaiting_failed",
                roomId,
                playerId,
                socketId,
                timestamp: Date.now()
            });

            return;

        }

        console.log("[TonConnect TRACE] handshake transition", {
            old: oldStatus,
            next: "WAITING",
            stage: "WAITING",
            reason: "DISCONNECTED",
            roomId,
            playerId,
            socketId,
            timestamp: Date.now()
        });

        this._touchTonConnectPlayerMeta(roomId, playerId, {
            lastStatusChangeAt: Date.now(),
            lastEvent: "WALLET_DISCONNECT_REPORT"
        });

        this._recordTonConnectEvent(roomId, {
            type: "DISCONNECTED",
            playerId
        });

        this._broadcastWalletConnectionSession(roomId);

    }

    /**
     * R6.8 — Read-only TonConnect diagnostics for Developer Console.
     * Does not mutate gameplay state.
     */
    getTonConnectDiagnostics(roomId) {

        if (!roomId) {

            return null;

        }

        const session = this._walletConnectionByRoom.get(roomId) ?? null;
        const events = this._tonConnectEventsByRoom.get(roomId) ?? [];
        const metaByPlayer = this._tonConnectPlayerMetaByRoom.get(roomId)
            ?? new Map();
        const paymentSession = this._paymentSessionManager?.getSession?.(roomId)
            ?? null;

        const seats = session
            ? session.players.map((seat) => {

                const meta = metaByPlayer.get(String(seat.playerId)) ?? {};
                const socketId = this._playerToSocket.get(seat.playerId)
                    ?? null;
                const player = this._playerManager.getPlayer?.(seat.playerId);
                const displayStatus = seat.status === "WAITING"
                    && meta.lastEvent === "WALLET_DISCONNECT_REPORT"
                    ? "DISCONNECTED"
                    : seat.status;

                return Object.freeze({
                    playerId: seat.playerId,
                    nickname: player?.identity?.nickname ?? null,
                    socketId,
                    status: seat.status,
                    displayStatus,
                    sessionWallet: seat.sessionWallet ?? null,
                    connectedWallet: seat.connectedWallet ?? null,
                    walletProvider: null,
                    walletName: null,
                    walletAddress: seat.connectedWallet
                        ?? seat.sessionWallet
                        ?? null,
                    walletChain: null,
                    walletNetwork: null,
                    walletPublicKey: null,
                    lastTonConnectEvent: meta.lastEvent ?? null,
                    lastStatusChangeAt: meta.lastStatusChangeAt ?? null,
                    lastReportAt: meta.lastReportAt ?? null
                });

            })
            : [];

        const statuses = seats.map((seat) => seat.status);
        const anyConnecting = statuses.includes("CONNECTING");
        const anyConnected = statuses.includes("CONNECTED");
        const allConnected = session?.paymentConnectionReady === true
            || (
                statuses.length > 0
                && statuses.every((status) => status === "CONNECTED")
            );
        const anyMismatch = statuses.includes("ADDRESS_MISMATCH");

        let handshakeStage = "IDLE";
        let handshakeOwner = "WalletConnectionSession";

        if (!session) {

            handshakeStage = "NO_SESSION";
            handshakeOwner = "RoomLobbyBridge";

        } else if (allConnected && session.paymentConnectionReady) {

            handshakeStage = "PAYMENT_READY";
            handshakeOwner = "Payment Session";

        } else if (allConnected) {

            handshakeStage = "CONNECTED";
            handshakeOwner = "WalletConnectionSession";

        } else if (anyMismatch) {

            handshakeStage = "ADDRESS_MISMATCH";
            handshakeOwner = "WalletConnectionSession";

        } else if (anyConnecting) {

            handshakeStage = "WAITING_FOR_CONNECTEVENT";
            handshakeOwner = "TonConnect SDK / Bridge";

        } else if (anyConnected) {

            handshakeStage = "PARTIAL_CONNECTED";
            handshakeOwner = "WalletConnectionSession";

        } else {

            handshakeStage = "WAITING";
            handshakeOwner = "TonConnect SDK";

        }

        const lastEvent = events.length > 0 ? events[events.length - 1] : null;

        return Object.freeze({
            roomId,
            hasWalletConnectionSession: Boolean(session),
            paymentConnectionReady: session?.paymentConnectionReady === true,
            paymentSessionActive: Boolean(paymentSession),
            paymentSessionStatus: paymentSession?.status ?? null,
            createdAt: session?.createdAt ?? null,
            handshakeStage,
            handshakeOwner,
            ownership: Object.freeze({
                tonConnectSdk: anyConnecting,
                bridge: anyConnecting,
                socket: seats.some((seat) => seat.socketId != null),
                roomLobbyBridge: Boolean(session),
                walletConnectionSession: Boolean(session),
                paymentSession: Boolean(paymentSession)
            }),
            bridge: Object.freeze({
                type: "http",
                provider: "wallet-registry",
                transport: "SSE",
                note: "Client SDK fields (chain/provider/appName) are not "
                    + "reported to the server; bridge activity inferred from "
                    + "WALLET_CONNECT_* lobby events.",
                connectedPlayers: statuses.filter(
                    (status) => status === "CONNECTED"
                ).length,
                waitingPlayers: statuses.filter(
                    (status) => status === "WAITING"
                    || status === "CONNECTING"
                ).length,
                disconnectedPlayers: seats.filter(
                    (seat) => seat.displayStatus === "DISCONNECTED"
                ).length,
                lastBridgeActivityAt: lastEvent?.at ?? null,
                sessionState: allConnected
                    ? "Connected"
                    : anyConnecting
                        ? "Waiting"
                        : session
                            ? "Disconnected"
                            : "None"
            }),
            players: Object.freeze(seats),
            events: Object.freeze(events.map((event) => Object.freeze({
                ...event
            }))),
            autopsy: this._projectTonConnectAutopsy(roomId)
        });

    }

    /**
     * R6.11E — Project latest forensic autopsy into tonConnect diagnostics.
     */
    _projectTonConnectAutopsy(roomId) {

        const store = this._tonConnectAutopsyByRoom.get(roomId);

        if (!store?.latest) {

            return null;

        }

        const latest = store.latest;
        const byPlayer = {};

        if (store.byPlayer instanceof Map) {

            for (const [playerId, entry] of store.byPlayer.entries()) {

                byPlayer[playerId] = Object.freeze({
                    ...(entry.autopsy ?? {}),
                    roomId: entry.roomId ?? roomId,
                    playerId: entry.playerId ?? playerId,
                    sessionId: entry.sessionId ?? null,
                    attemptId: entry.attemptId ?? null,
                    startedAt: entry.startedAt ?? null,
                    capturedAt: entry.capturedAt ?? null,
                    receivedAt: entry.receivedAt ?? null,
                    flushReason: entry.flushReason ?? null
                });

            }

        }

        return Object.freeze({
            ...latest.autopsy,
            roomId: latest.roomId ?? roomId,
            playerId: latest.playerId ?? null,
            sessionId: latest.sessionId ?? null,
            attemptId: latest.attemptId ?? null,
            startedAt: latest.startedAt ?? null,
            capturedAt: latest.capturedAt ?? null,
            receivedAt: latest.receivedAt ?? null,
            flushReason: latest.flushReason ?? null,
            byPlayer: Object.freeze(byPlayer)
        });

    }

    /**
     * R6.11E — Ingest forensic autopsy snapshot (socket or HTTP beacon).
     * Does not mutate wallet handshake / payment state.
     */
    ingestTonConnectAutopsySnapshot(rawPayload = {}, hints = {}) {

        const payload = rawPayload && typeof rawPayload === "object"
            ? rawPayload
            : {};

        const autopsyIn = payload.autopsy && typeof payload.autopsy === "object"
            ? payload.autopsy
            : payload;

        const roomId = hints.roomId
            ?? payload.roomId
            ?? null;

        if (!roomId) {

            return false;

        }

        const playerId = hints.playerId
            ?? payload.playerId
            ?? null;

        const playerKey = playerId != null ? String(playerId) : "_unknown";

        const normalizedAutopsy = Object.freeze({
            lastSuccessfulStep: autopsyIn.lastSuccessfulStep ?? null,
            failureStep: autopsyIn.failureStep ?? null,
            timeline: Object.freeze(
                Array.isArray(autopsyIn.timeline)
                    ? autopsyIn.timeline.slice(-120)
                    : []
            ),
            sdkErrors: Object.freeze(
                Array.isArray(autopsyIn.sdkErrors)
                    ? autopsyIn.sdkErrors.slice(-40)
                    : []
            ),
            walletEvents: Object.freeze(
                Array.isArray(autopsyIn.walletEvents)
                    ? autopsyIn.walletEvents.slice(-40)
                    : []
            ),
            browserErrors: Object.freeze(
                Array.isArray(autopsyIn.browserErrors)
                    ? autopsyIn.browserErrors.slice(-40)
                    : []
            ),
            rawObjects: Object.freeze(
                Array.isArray(autopsyIn.rawObjects)
                    ? autopsyIn.rawObjects.slice(-40)
                    : []
            )
        });

        const entry = Object.freeze({
            roomId: String(roomId),
            playerId: playerId != null ? String(playerId) : null,
            sessionId: payload.sessionId ?? null,
            attemptId: payload.attemptId ?? null,
            startedAt: payload.startedAt ?? null,
            capturedAt: payload.capturedAt ?? null,
            flushReason: payload.flushReason ?? null,
            receivedAt: new Date().toISOString(),
            autopsy: normalizedAutopsy
        });

        let store = this._tonConnectAutopsyByRoom.get(roomId);

        if (!store) {

            store = {
                latest: null,
                byPlayer: new Map()
            };
            this._tonConnectAutopsyByRoom.set(roomId, store);

        }

        store.byPlayer.set(playerKey, entry);
        store.latest = entry;

        this._recordTonConnectEvent(roomId, {
            type: "TONCONNECT_AUTOPSY_SNAPSHOT",
            playerId: entry.playerId,
            detail: Object.freeze({
                sessionId: entry.sessionId,
                failureStep: normalizedAutopsy.failureStep,
                lastSuccessfulStep: normalizedAutopsy.lastSuccessfulStep,
                timelineCount: normalizedAutopsy.timeline.length,
                flushReason: entry.flushReason
            })
        });

        return true;

    }

    _handleTonConnectAutopsySnapshot(socketId, payload, hints = {}) {

        const context = this._getSocketContext(socketId);

        const roomId = context?.roomId
            ?? hints.roomId
            ?? payload?.roomId
            ?? null;

        const playerId = context?.playerId
            ?? hints.playerId
            ?? payload?.playerId
            ?? null;

        if (!roomId) {

            return;

        }

        this.ingestTonConnectAutopsySnapshot(payload, {
            roomId,
            playerId
        });

    }

    _recordTonConnectEvent(roomId, { type, playerId = null, detail = null }) {

        if (!roomId || !type) {

            return;

        }

        const list = this._tonConnectEventsByRoom.get(roomId) ?? [];

        list.push(Object.freeze({
            at: Date.now(),
            type,
            playerId,
            detail
        }));

        const MAX_EVENTS = 50;

        if (list.length > MAX_EVENTS) {

            list.splice(0, list.length - MAX_EVENTS);

        }

        this._tonConnectEventsByRoom.set(roomId, list);

    }

    _touchTonConnectPlayerMeta(roomId, playerId, patch) {

        if (!roomId || !playerId || !patch) {

            return;

        }

        let byPlayer = this._tonConnectPlayerMetaByRoom.get(roomId);

        if (!byPlayer) {

            byPlayer = new Map();
            this._tonConnectPlayerMetaByRoom.set(roomId, byPlayer);

        }

        const key = String(playerId);
        const previous = byPlayer.get(key) ?? {};

        byPlayer.set(key, {
            ...previous,
            ...patch
        });

    }

    _broadcastWalletConnectionSession(roomId) {

        const session = this._walletConnectionByRoom.get(roomId);

        if (!session) {

            return;

        }

        const snapshot = session.toSnapshot();

        console.log("[TonConnect TRACE] broadcast WALLET_CONNECTION_SESSION_UPDATED", {
            roomId,
            paymentConnectionReady: snapshot.paymentConnectionReady,
            players: snapshot.players.map((p) => ({
                playerId: p.playerId,
                status: p.status
            })),
            timestamp: Date.now()
        });

        this._deliverToRoom(
            roomId,
            LOBBY_SERVER_EVENTS.WALLET_CONNECTION_SESSION_UPDATED,
            snapshot
        );

    }

    _deliverPaymentConnectionReady(roomId) {

        this._clearWalletConnectionTimeout(roomId);

        console.log("[TonConnect TRACE] handshake transition", {
            old: "CONNECTED",
            next: "PAYMENT_READY",
            stage: "PAYMENT_READY",
            reason: "deliver_PAYMENT_CONNECTION_READY",
            roomId,
            timestamp: Date.now()
        });

        // R7.50 temporary diagnostics — EventBus emit before PaymentSessionManager.
        console.log("[R7.50 DIAG] emitting PAYMENT_CONNECTION_READY", {
            roomId,
            event: EVENT_TYPES.PAYMENT_CONNECTION_READY,
            subscriberHint: "PaymentSessionManager._handlePaymentConnectionReady",
            timestamp: Date.now()
        });

        this._eventBus.emit({
            source: EVENT_SOURCES.ROOM_LOBBY_BRIDGE,
            type: EVENT_TYPES.PAYMENT_CONNECTION_READY,
            payload: { roomId, timestamp: Date.now() }
        });

        console.log("[R7.50 DIAG] PAYMENT_CONNECTION_READY emit returned", {
            roomId,
            hasPaymentSessionAfterEmit: Boolean(
                this._paymentSessionManager?.getSession?.(roomId)
            ),
            paymentSessionId: this._paymentSessionManager?.getSession?.(roomId)
                ?.paymentSessionId ?? null,
            timestamp: Date.now()
        });

        this._deliverToRoom(
            roomId,
            LOBBY_SERVER_EVENTS.PAYMENT_CONNECTION_READY,
            { roomId }
        );

        this._logger.info(`Payment connection ready | roomId=${roomId}`);

        this._logger.decisionTrace({
            stage: "PAYMENT_CONNECTION_READY",
            decision: "ALLOW",
            reason: "All wallets connected.",
            caller: "RoomLobbyBridge._deliverPaymentConnectionReady",
            nextAction: "Create PaymentSession",
            roomId
        });

        this._logger.decisionTrace({
            stage: "TERMINAL_SUCCESS",
            decision: "WALLET_CONNECTION",
            reason: "Wallet connection barrier cleared.",
            caller: "RoomLobbyBridge._deliverPaymentConnectionReady",
            nextAction: "Create PaymentSession",
            roomId
        });

    }

    _scheduleWalletConnectionTimeout(roomId) {

        if (!roomId || this._walletConnectionTimersByRoom.has(roomId)) {

            return;

        }

        const timeoutId = setTimeout(() => {

            this._walletConnectionTimersByRoom.delete(roomId);

            this._handleWalletConnectionTimeout(roomId);

        }, this._walletConnectionDurationMs);

        this._walletConnectionTimersByRoom.set(roomId, timeoutId);

    }

    _clearWalletConnectionTimeout(roomId) {

        const timeoutId = this._walletConnectionTimersByRoom.get(roomId);

        if (!timeoutId) {

            return;

        }

        clearTimeout(timeoutId);

        this._walletConnectionTimersByRoom.delete(roomId);

    }

    /**
     * R7.24 — Stage-owned wallet barrier terminator.
     * Soft-disconnect protection must not leave ARCHIVED rooms forever.
     */
    _handleWalletConnectionTimeout(roomId) {

        if (!roomId || !this._roomManager.getRoom(roomId)) {

            return;

        }

        const session = this._walletConnectionByRoom.get(roomId);

        if (session?.paymentConnectionReady === true) {

            return;

        }

        this._logger.decisionTrace({
            stage: "LIFECYCLE_TIMEOUT",
            decision: "WALLET_CONNECTION_TIMEOUT",
            reason: `Wallet connection exceeded ${this._walletConnectionDurationMs}ms`,
            caller: "RoomLobbyBridge._handleWalletConnectionTimeout",
            nextAction: "TERMINAL_FAILURE → _closeRoom",
            roomId
        });

        this._logger.decisionTrace({
            stage: "TERMINAL_FAILURE",
            decision: "FAIL",
            reason: "wallet_connection_timeout",
            caller: "RoomLobbyBridge._handleWalletConnectionTimeout",
            nextAction: "ROOM_TERMINATION",
            roomId
        });

        this._deliverToRoom(
            roomId,
            LOBBY_SERVER_EVENTS.PAYMENT_SESSION_FAILED,
            {
                roomId,
                reason: "wallet_connection_timeout"
            }
        );

        this._logger.decisionTrace({
            stage: "ROOM_TERMINATION",
            decision: "CLOSE",
            reason: "wallet_connection_timeout",
            caller: "RoomLobbyBridge._handleWalletConnectionTimeout",
            nextAction: "destroyRoom()",
            roomId
        });

        this._closeRoom(roomId, "wallet_connection_timeout");

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

        this._logger.decisionTrace({
            stage: "TERMINAL_FAILURE",
            decision: "FAIL",
            reason: payload?.reason ?? "payment_failed",
            caller: "RoomLobbyBridge._handlePaymentSessionFailed",
            nextAction: "ROOM_TERMINATION → _closeRoom",
            roomId
        });

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

        this._logger.decisionTrace({
            stage: "TERMINAL_FAILURE",
            decision: "FAIL",
            reason: payload?.reason ?? "game_start_failed",
            caller: "RoomLobbyBridge._handleGameStartFailed",
            nextAction: "ROOM_TERMINATION → _closeRoom",
            roomId
        });

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

        this._tonConnectEventsByRoom.delete(roomId);

        this._tonConnectPlayerMetaByRoom.delete(roomId);

        this._tonConnectAutopsyByRoom.delete(roomId);

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

        this._logger.decisionTrace({
            stage: "VERIFY_COMPLETE",
            decision: "PASS",
            reason: `All ${revealedPlayers.length} players verified.`,
            caller: "RoomLobbyBridge._revealVerifyRoster",
            nextAction: "await VERIFY_NEXT wallets → archiveForPayment()",
            roomId
        });

    }

    _clearVerifyBarrier(roomId) {

        this._verifyConfirmedByRoom.delete(roomId);

        this._profilesRevealedByRoom.delete(roomId);

        this._allProfilesReadyByRoom.delete(roomId);

        this._verifyIconsAssignedByRoom.delete(roomId);

        this._continueToPaymentByRoom.delete(roomId);

        this._paymentStageReadyByRoom.delete(roomId);

        this._clearWalletConnectionTimeout(roomId);

        this._destroyEntryPaymentArtifacts(roomId);

        this._secretMatrixByRoom.delete(roomId);

        this._secretMatrixRevisionByRoom.delete(roomId);

        this._secretMatrixAcceptedByRoom.delete(roomId);

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

    /**
     * R7.5A — Gate mutating lobby commands to the single authoritative socket.
     * @returns {object|null} socket context when allowed; null when rejected.
     */
    _assertAuthoritativeMutation(socketId, eventName) {

        if (this._obsoleteSockets.has(socketId)) {

            const meta = this._obsoleteSockets.get(socketId);

            this._logger.info(
                `SOCKET_OBSOLETE_PACKET`
                + ` | socketId=${socketId}`
                + ` | playerId=${meta?.playerId ?? "null"}`
                + ` | roomId=${meta?.roomId ?? "null"}`
                + ` | event=${eventName}`
                + ` | reason=obsolete_socket`
            );

            this._emitRoomError(socketId, LOBBY_ERROR_CODES.UNKNOWN_ERROR);

            return null;

        }

        if (this._pendingSockets.has(socketId)) {

            const meta = this._pendingSockets.get(socketId);

            this._logger.info(
                `SOCKET_PENDING_PACKET`
                + ` | socketId=${socketId}`
                + ` | playerId=${meta?.playerId ?? "null"}`
                + ` | roomId=${meta?.roomId ?? "null"}`
                + ` | event=${eventName}`
                + ` | reason=pending_not_authoritative`
            );

            this._emitRoomError(socketId, LOBBY_ERROR_CODES.UNKNOWN_ERROR);

            return null;

        }

        const context = this._getSocketContext(socketId);

        if (!context) {

            this._emitRoomError(socketId, LOBBY_ERROR_CODES.UNKNOWN_ERROR);

            return null;

        }

        return context;

    }

    _markPendingSocket(socketId, playerId, roomId) {

        if (!socketId) {

            return;

        }

        this._pendingSockets.set(socketId, {
            playerId: playerId ?? null,
            roomId: roomId ?? null
        });

        this._obsoleteSockets.delete(socketId);

    }

    _clearPendingSocket(socketId) {

        if (!socketId) {

            return;

        }

        this._pendingSockets.delete(socketId);

    }

    /**
     * R7.5A — Atomic authoritative socket ownership transfer.
     * Synchronous only: no await, emit side-effects beyond map ops before return
     * except force-disconnect delivery after maps are committed.
     */
    _commitSocketAuthority({
        playerId,
        roomId,
        oldSocketId = null,
        newSocketId
    }) {

        this._logger.info(
            `SOCKET_COMMIT_BEGIN`
            + ` | roomId=${roomId ?? "null"}`
            + ` | playerId=${playerId ?? "null"}`
            + ` | oldSocketId=${oldSocketId ?? "null"}`
            + ` | newSocketId=${newSocketId ?? "null"}`
        );

        if (!playerId || !newSocketId) {

            this._logger.info(
                `SOCKET_COMMIT_VALIDATE`
                + ` | success=false`
                + ` | reason=missing_player_or_socket`
            );

            this._logger.info(
                `SOCKET_COMMIT_ROLLBACK`
                + ` | reason=missing_player_or_socket`
                + ` | currentOwner=${this._playerToSocket.get(playerId) ?? "null"}`
            );

            return {
                ok: false,
                reason: "Socket ownership commit requires playerId and newSocketId"
            };

        }

        if (!this._playerManager.hasPlayer(playerId)) {

            this._logger.info(
                `SOCKET_COMMIT_VALIDATE`
                + ` | success=false`
                + ` | reason=player_missing`
            );

            this._logger.info(
                `SOCKET_COMMIT_ROLLBACK`
                + ` | reason=player_missing`
                + ` | currentOwner=${this._playerToSocket.get(playerId) ?? "null"}`
            );

            return { ok: false, reason: "Player does not exist" };

        }

        if (roomId && !this._roomManager.getRoom(roomId)) {

            this._logger.info(
                `SOCKET_COMMIT_VALIDATE`
                + ` | success=false`
                + ` | reason=room_missing`
            );

            this._logger.info(
                `SOCKET_COMMIT_ROLLBACK`
                + ` | reason=room_missing`
                + ` | currentOwner=${this._playerToSocket.get(playerId) ?? "null"}`
            );

            return { ok: false, reason: "Room session is not active" };

        }

        this._logger.info(
            `SOCKET_COMMIT_VALIDATE`
            + ` | success=true`
            + ` | reason=ok`
        );

        const previousOwner = this._playerToSocket.get(playerId) ?? null;

        const resolvedOld = oldSocketId
            ?? (
                previousOwner && previousOwner !== newSocketId
                    ? previousOwner
                    : null
            );

        // Retire old socket mapping without clearing player ownership first.
        if (resolvedOld && resolvedOld !== newSocketId) {

            if (this._socketToPlayer.get(resolvedOld) === playerId) {

                this._socketToPlayer.delete(resolvedOld);

            }

            this._gameplayContextResolver?.unbindSocket(resolvedOld);

            this._deliverSocketLeaveRoom(resolvedOld);

            this._obsoleteSockets.set(resolvedOld, {
                playerId,
                roomId: roomId ?? null
            });

            this._pendingSockets.delete(resolvedOld);

        }

        const existingPlayerForSocket = this._socketToPlayer.get(newSocketId);

        if (existingPlayerForSocket && existingPlayerForSocket !== playerId) {

            this._socketToPlayer.delete(newSocketId);

            if (this._playerToSocket.get(existingPlayerForSocket) === newSocketId) {

                this._playerToSocket.delete(existingPlayerForSocket);

            }

            this._gameplayContextResolver?.unbindSocket(newSocketId);

        }

        this._socketToPlayer.set(newSocketId, playerId);

        this._playerToSocket.set(playerId, newSocketId);

        this._pendingSockets.delete(newSocketId);

        this._obsoleteSockets.delete(newSocketId);

        this._clearRecoveryOwnershipForPlayer(playerId);

        this._logger.info(
            `SOCKET_COMMIT_SUCCESS`
            + ` | roomId=${roomId ?? "null"}`
            + ` | playerId=${playerId}`
            + ` | oldSocketId=${resolvedOld ?? "null"}`
            + ` | newSocketId=${newSocketId}`
        );

        return {
            ok: true,
            oldSocketId: resolvedOld,
            newSocketId
        };

    }

    _requestForceDisconnect(socketId) {

        if (!socketId) {

            return;

        }

        this._eventBus.emit({
            source: EVENT_SOURCES.ROOM_LOBBY_BRIDGE,
            type: EVENT_TYPES.LOBBY_SOCKET_DELIVERY,
            payload: {
                target: "disconnect",
                socketId
            }
        });

    }

    /**
     * Initial bind (create/join) or transfer via commit when replacing.
     * Must never leave a recoverable player with zero owners mid-call.
     */
    _registerSocketPlayer(socketId, playerId) {

        if (!socketId || !playerId) {

            return;

        }

        const existingSocketForPlayer = this._playerToSocket.get(playerId);

        if (existingSocketForPlayer && existingSocketForPlayer !== socketId) {

            const roomId = this._playerManager.getRuntime(playerId)?.roomId
                ?? null;

            this._commitSocketAuthority({
                playerId,
                roomId,
                oldSocketId: existingSocketForPlayer,
                newSocketId: socketId
            });

            return;

        }

        const existingPlayerForSocket = this._socketToPlayer.get(socketId);

        if (existingPlayerForSocket && existingPlayerForSocket !== playerId) {

            if (this._playerToSocket.get(existingPlayerForSocket) === socketId) {

                this._playerToSocket.delete(existingPlayerForSocket);

            }

            this._socketToPlayer.delete(socketId);

            this._gameplayContextResolver?.unbindSocket(socketId);

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
     * Soft disconnect / reconnect while a Setup Session is recoverable
     * (ACTIVE / COMPLETED / ARCHIVED) or while Game Session has started
     * (_startedRooms). R6.38 — ARCHIVED keeps reclaim/SYNC but Setup no longer
     * owns room destroy after PAYMENT_STAGE_READY.
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

            // R7.5A — allow atomic transfer; do not unregister (avoids zero-owner gap).
            this._logger.info(
                `[R6.2A Recovery] authorization`
                + ` | check=runtime_seat_fallback`
                + ` | result=pass`
                + ` | action=transfer_allowed`
                + ` | boundSocket.id=${boundSocket}`
                + ` | connectionState=${connectionState ?? "null"}`
                + ` | playerId=${claimedPlayerId}`
                + ` | socket.id=${socketId}`
            );

            this._markPendingSocket(socketId, claimedPlayerId, roomId);

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
