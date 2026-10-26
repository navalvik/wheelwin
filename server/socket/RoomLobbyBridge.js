import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { registerRoomDestroyContext } from "../recovery/RoomDestroyContextRegistry.js";
import { page6LifecycleDiag } from "../logging/page6LifecycleDiag.js";
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
    LIVE_PAYMENT_ACCEPTANCE_DISABLED_REASON,
    LIVE_PAYMENT_ACCEPTANCE_ENABLED
} from "../payment/PaymentLifecycleAvailability.js";
import { PAYMENT_INTENT_STATE } from "../payment/PaymentIntentStatus.js";
import {
    INCOMING_PRINCIPAL_CONFIRMATION_SOURCE,
    LEDGER_ENTRY_KIND
} from "../payment/ledger/index.js";
import { createHash } from "node:crypto";
import {
    LOBBY_ERROR_CODES,
    LOBBY_ERROR_MESSAGES,
    LOBBY_SERVER_EVENTS
} from "./lobbyProtocol.js";

import {
    RecoveryCredentialStore
} from "../gameplay/RecoveryCredentialStore.js";

export class RoomLobbyBridge {

    constructor({
        logger,
        eventBus,
        roomManager,
        playerManager,
        gameplayContextResolver = null,
        setupSessionLifecycle = null,
        resultSessionLifecycle = null,
        gameStartAuthorization = null,
        isDevelopment = false,
        lifecycleManager = null,
        roomConfig = null,
        telegramIdentityResolver = null,
        paymentApplicationBinding = null,
        metricsService = null
    }) {

        this._logger = logger;

        this._eventBus = eventBus;

        this._roomManager = roomManager;

        this._playerManager = playerManager;

        this._gameplayContextResolver = gameplayContextResolver;

        this._setupSessionLifecycle = setupSessionLifecycle;

        this._resultSessionLifecycle = resultSessionLifecycle;

        this._gameStartAuthorization = gameStartAuthorization;

        // R7.0B — drain awareness for lobby create-room.
        this._lifecycleManager = lifecycleManager;

        // R17.9T.8 — passive Attack E observability. Optional MetricsService
        // for monotonic CREATE_ROOM counters (rooms.created / rejections).
        // Never gates behavior; increment() no-ops when disabled/absent.
        this._metricsService = metricsService;

        // R1.3D — DEBUG_START_GAME is development-only.
        this._isDevelopment = isDevelopment === true;

        this._socketToPlayer = new Map();

        this._playerToSocket = new Map();

        this._roomCreators = new Map();

        // R17.9T.6-C — server-side trusted Telegram identity lookup.
        // Function: (socketId) => telegramUserId | null. The identity MUST come
        // from the authenticated socket context established by SocketGateway
        // (socket.data.telegramUserId). Never from client payloads.
        // Fail-closed: when no resolver is configured, CREATE_ROOM is rejected.
        this._telegramIdentityResolver = telegramIdentityResolver;

        // R17.9T.6-C — one active created room per Telegram user.
        // telegramUserId → activeCreatedRoomId. Creation-quota only; joining is
        // never limited by this map. Released whenever the room is destroyed.
        this._activeRoomsByTelegramUser = new Map();

        // R20 — one-time authoritative room network selection (post-CREATE_ROOM).
        // roomId → "testnet" | "mainnet". Absent until the verified room Owner
        // commits the choice. In-memory only; never part of the Room model and
        // never persisted. Released by the existing room destruction paths.
        this._roomNetworkByRoom = new Map();

        // R22 — pending MAINNET cross-runtime handoff continuation.
        // roomId → opaque handoffId of the record created in the SINGLE shared
        // app-level RoomNetworkHandoffStore (injected by WheelWinServer via
        // configureRoomNetworkHandoffStore()). This map is the minimum state
        // required so the existing room destruction paths can release an
        // outstanding handoff. Records are created ONLY for MAINNET selections
        // and ONLY from server-authoritative owner identity. The bridge never
        // instantiates its own store.
        this._roomNetworkHandoffIdByRoom = new Map();

        // R23 — Mainnet-side idempotency mapping for the handoff bootstrap.
        // handoffId → authoritative Mainnet roomId CREATED for this handoff.
        // Server-side only, in-memory, runtime-local. Enforces
        // ONE HANDOFF → AT MOST ONE MAINNET ROOM. A runtime restart drops
        // both this mapping and the RoomManager rooms with it (documented
        // restart semantics); recovery of a COMPLETED handoff after a restart
        // comes from the Testnet store's completed record (claim returns the
        // authoritative mainnetRoomId) and is re-verified against the live
        // room registry before it is reused.
        this._paymentApplicationBinding = paymentApplicationBinding;

        // R23 — Mainnet-side HTTP client for the R21 Testnet handoff
        // contract (claim/complete). Injected by WheelWinServer; never
        // instantiated here; the shared secret stays inside the client.
        // Fail-closed: without a configured client every bootstrap request
        // is rejected without any network activity.
        this._roomNetworkHandoffClient = null;

        // Server-owned recovery identity keyed by socket id (CSR / same-id path).
        this._recoveryOwnershipBySocket = new Map();

        // R6.1 — Server-owned recovery identity keyed by persistent playerId.
        // New socket.id reclaim uses this map; client claim is only a lookup key.
        this._recoveryOwnershipByPlayer = new Map();

        // R13.1E — per-player recovery credentials (hashed; plaintext never stored).
        this._recoveryCredentials = new RecoveryCredentialStore();

        // R7.5A — sockets that requested reclaim but are not yet authoritative.
        this._pendingSockets = new Map();

        // R7.5A — retired sockets after atomic commit (late packets logged/rejected).
        this._obsoleteSockets = new Map();

        this._lastRecoveryDenial = null;

        // Rooms whose Game Session has started (post Setup Session completion).
        this._startedRooms = new Set();

        // R6.5 — rooms currently running the single SESSION_FINISHED cleanup path.
        this._finishingResultSessions = new Set();

        // Verify barrier: profiles stay private until every player confirms.
        this._verifyConfirmedByRoom = new Map();

        this._profilesRevealedByRoom = new Set();

        // R5.15 — rooms that have emitted ALL_PLAYER_PROFILES_READY (once).
        this._allProfilesReadyByRoom = new Set();

        // R5.17 — rooms that have received VERIFY-phase icon assignment (once).
        this._verifyIconsAssignedByRoom = new Set();

        // C5.8A — continuation barrier: all verified players press NEXT before
        // the game start gate evaluates. Keyed by roomId → Set(playerId).
        this._continueToVerifyByRoom = new Map();

        this._verifyBarrierCompletedByRoom = new Set();


        // Secret Matrix submissions keyed by roomId → Map(playerId → cells).
        this._secretMatrixByRoom = new Map();

        // R7.7A — monotonic revision per room for SECRET_MATRIX_STATUS.
        this._secretMatrixRevisionByRoom = new Map();

        // R7.7A — rooms that reached MATCH_ACCEPTED (until barrier clear).
        this._secretMatrixAcceptedByRoom = new Set();

        this._handlers = [];

        this._initialized = false;


    }


    /**
     * R17.9T.6-C — wire the server-side Telegram identity lookup.
     *
     * Expected production resolver reads ONLY authenticated socket state:
     *   (socketId) => io.sockets.sockets.get(socketId)?.data?.telegramUserId ?? null
     *
     * Client-supplied telegramUserId values are never accepted. When no
     * resolver is configured the bridge fails closed: every CREATE_ROOM is
     * rejected with ROOM_CREATION_REQUIRES_TELEGRAM.
     */
    configureTelegramIdentityResolver(resolver) {

        this._telegramIdentityResolver =
            typeof resolver === "function" ? resolver : null;

    }

    _resolveSocketTelegramUserId(socketId) {

        if (!socketId || typeof this._telegramIdentityResolver !== "function") {

            return null;

        }

        let resolved = null;

        try {

            resolved = this._telegramIdentityResolver(socketId);

        } catch {

            return null;

        }

        return typeof resolved === "number" || typeof resolved === "string"
            ? resolved
            : null;

    }

    _releaseTelegramQuota(roomId) {

        if (!roomId) {

            return;

        }

        for (const [telegramUserId, activeRoomId] of this
            ._activeRoomsByTelegramUser.entries()) {

            if (activeRoomId === roomId) {

                this._activeRoomsByTelegramUser.delete(telegramUserId);

                return;

            }

        }

    }
    /**
     * R22 — wire the SINGLE app-level RoomNetworkHandoffStore created by
     * WheelWinServer (getRoomNetworkHandoffStore()). The bridge never
     * instantiates its own store. Left unset until configured so runtimes
     * without the handoff store keep the legacy R20 selection behavior.
     */
    configureRoomNetworkHandoffStore(handoffStore) {

        this._roomNetworkHandoffStore = handoffStore ?? null;

    }

    /**
     * R23 — wire the SINGLE Mainnet-side RoomNetworkHandoffClient (R21)
     * created by WheelWinServer. The bridge never instantiates its own
     * client and never sees the shared secret (the client holds it).
     */
    configureRoomNetworkHandoffClient(handoffClient) {

        this._roomNetworkHandoffClient = handoffClient ?? null;

        return this;

    }

    configurePaymentApplicationBinding(binding) {

        if (binding !== null && typeof binding !== "object") {
            return;
        }

        this._paymentApplicationBinding = binding;

        return this;

    }

    /**
     * R22 — trusted Telegram identity of the authoritative room Owner.
     *
     * Resolved ONLY from the server-side `_activeRoomsByTelegramUser` record
     * pinned at CREATE_ROOM from the authenticated socket context (the same
     * trusted resolver that authorizes CREATE_ROOM). Client payloads are
     * never consulted. Fail-closed: missing record → null.
     */
    _resolveRoomOwnerTelegramUserId(roomId) {

        if (!roomId) {

            return null;

        }

        for (const [telegramUserId, activeRoomId] of this
            ._activeRoomsByTelegramUser.entries()) {

            if (activeRoomId === roomId) {

                return telegramUserId;

            }

        }

        return null;

    }

    /**
     * R22 — create the pending cross-runtime handoff for a MAINNET selection.
     *
     * Authoritative inputs ONLY:
     * - roomId: the authoritative room context (never a client-supplied id);
     * - ownerPlayerId: the existing authoritative creator mapping
     *   (`_roomCreators`), never a client-supplied ownership proof;
     * - ownerTelegramUserId: the trusted Telegram identity pinned at
     *   CREATE_ROOM, never a client-supplied identity.
     *
     * Returns the opaque { handoffId, targetNetwork, expiresAt } result or
     * null on failure. Internal record fields are never exposed and the
     * handoffId is never logged.
     */
    _createRoomNetworkHandoff(roomId, handoffStore) {

        const ownerPlayerId = this._roomCreators.get(roomId) ?? null;

        const ownerTelegramUserId = this._resolveRoomOwnerTelegramUserId(roomId);

        if (!ownerPlayerId || ownerTelegramUserId == null) {

            this._logger.warn(
                `[RoomLobbyBridge] ROOM_NETWORK_HANDOFF | refused: missing ` +
                `authoritative owner identity | roomId=${roomId}`
            );

            return null;

        }

        try {

            const handoff = handoffStore.create({
                roomId,
                ownerPlayerId,
                ownerTelegramUserId
            });

            // Minimum roomId → handoffId mapping so the existing room
            // destruction paths can release an outstanding handoff.
            this._roomNetworkHandoffIdByRoom.set(roomId, handoff.handoffId);

            this._logger.info(
                `[RoomLobbyBridge] ROOM_NETWORK_HANDOFF | pending handoff ` +
                `armed for the verified Owner (continuation token delivered ` +
                `to the Owner socket only) | roomId=${roomId}`
            );

            return handoff;

        } catch (error) {

            // Server-side only: no exception detail ever reaches a client.
            this._logger.error(
                `[RoomLobbyBridge] ROOM_NETWORK_HANDOFF | creation failed; ` +
                `MAINNET selection not committed | roomId=${roomId} | ` +
                `error=${error instanceof Error ? error.message : String(error)}`
            );

            return null;

        }

    }

    /**
     * R22 — deliver the opaque handoff continuation to the verified Owner's
     * authenticated socket ONLY. Never broadcast, never sent to joiners,
     * spectators or any other socket. Payload carries only:
     * { roomId, handoffId, targetNetwork, expiresAt }.
     */
    _deliverRoomNetworkHandoffReady(roomId, ownerPlayerId, handoff) {

        const ownerSocketId = this._playerToSocket.get(ownerPlayerId) ?? null;

        if (!ownerSocketId) {

            this._logger.warn(
                `[RoomLobbyBridge] ROOM_NETWORK_HANDOFF | Owner socket not ` +
                `bound; continuation not delivered | roomId=${roomId}`
            );

            return;

        }

        this._deliverToSocket(
            ownerSocketId,
            LOBBY_SERVER_EVENTS.ROOM_NETWORK_HANDOFF_READY,
            {
                roomId,
                handoffId: handoff.handoffId,
                targetNetwork: handoff.targetNetwork ?? "mainnet",
                expiresAt: handoff.expiresAt ?? null
            }
        );

    }

    /**
     * R22 — release an outstanding handoff through the existing room
     * destruction paths (setup-expired teardown, empty-room close, _closeRoom).
     * Uses the shared store's own release(); the roomId mapping is always
     * dropped, even when the store release fails. A handoff already
     * claimed/completed by the future Mainnet bootstrap is unaffected in
     * normal ordering (the bootstrap completes before the Testnet room is
     * destroyed); releasing such a record is at worst an early TTL removal,
     * never a financial or gameplay event.
     */
    _releaseRoomNetworkHandoff(roomId) {

        if (!roomId) {

            return;

        }

        const handoffId = this._roomNetworkHandoffIdByRoom.get(roomId) ?? null;

        if (handoffId == null) {

            return;

        }

        this._roomNetworkHandoffIdByRoom.delete(roomId);

        const handoffStore = this._roomNetworkHandoffStore ?? null;

        if (!handoffStore || typeof handoffStore.release !== "function") {

            return;

        }

        try {

            handoffStore.release(handoffId);

        } catch {

            // Non-fatal: the record also expires by the store TTL.

        }

    }



    initialize() {

        this._subscribe(
            EVENT_TYPES.LOBBY_CREATE_ROOM_REQUEST,
            (envelope) => {

                this._handleCreateRoom(envelope.payload.socketId);

            }
        );

        // R20 — room Owner network selection (client "selectRoomNetwork").
        this._subscribe(
            EVENT_TYPES.LOBBY_SELECT_ROOM_NETWORK_REQUEST,
            (envelope) => {

                this._handleSelectRoomNetwork(
                    envelope.payload.socketId,
                    envelope.payload.network
                );

            }
        );

        // R23 — Mainnet handoff bootstrap (client
        // "roomNetworkHandoffBootstrapRequest"). Only { socketId, handoffId }
        // is forwarded by SocketGateway; the handler resolves identity and
        // room creation server-side.
        this._subscribe(
            EVENT_TYPES.LOBBY_ROOM_NETWORK_HANDOFF_BOOTSTRAP_REQUEST,
            (envelope) => {

                this._handleRoomNetworkHandoffBootstrap(
                    envelope.payload.socketId,
                    envelope.payload.handoffId
                );

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
                    envelope.payload.socketId
                );

            }
        );

        this._subscribe(
            EVENT_TYPES.LOBBY_DEBUG_START_GAME_REQUEST,
            (envelope) => {

                this._handleDebugStartGame(envelope.payload.socketId);

            }
        );

        // P6.7 — narrowly scoped authoritative payment-state re-delivery.
        // Page4 requests its own current payment status after mounting so it
        // never stays stale when the original ENTRY_PAYMENT_SESSION_UPDATED
        // event was emitted while the page was not yet subscribed. The server
        // re-derives the status from the authoritative payment runtime and the
        // durable payment records; it never fabricates a status.
        this._subscribe(
            EVENT_TYPES.LOBBY_PAYMENT_STATUS_REQUEST,
            (envelope) => {

                this._handlePaymentStatusRequest(envelope.payload.socketId);

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

        this._roomNetworkByRoom.clear();

        // R22 — drop the roomId → handoffId mapping on teardown. The shared
        // RoomNetworkHandoffStore is torn down with the runtime (pending
        // handoffs are invalidated by design on restart).
        this._roomNetworkHandoffIdByRoom.clear();

        // R23 — drop the handoffId → Mainnet roomId idempotency mapping on
        // teardown (restart semantics documented on the map itself).
        if (this._roomNetworkHandoffRoomByHandoff) {
            this._roomNetworkHandoffRoomByHandoff.clear();
        }

        this._activeRoomsByTelegramUser.clear();

        this._recoveryOwnershipBySocket.clear();

        this._recoveryOwnershipByPlayer.clear();

        this._recoveryCredentials.clear();

        this._pendingSockets.clear();

        this._obsoleteSockets.clear();

        this._startedRooms.clear();

        this._finishingResultSessions.clear();

        this._verifyConfirmedByRoom.clear();

        this._profilesRevealedByRoom.clear();

        this._allProfilesReadyByRoom.clear();

        this._verifyIconsAssignedByRoom.clear();

        this._continueToVerifyByRoom.clear();

        this._verifyBarrierCompletedByRoom.clear();

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

        // R17.9T.6-C — CREATE_ROOM requires an authenticated Telegram Mini App
        // identity taken from the trusted server-side socket context. Web
        // sockets (telegramUserId == null) are rejected before ANY allocation:
        // no room, player, setup session or recovery credential is created.
        const creatorTelegramUserId = this._resolveSocketTelegramUserId(socketId);

        if (creatorTelegramUserId == null) {

            this._logger.decisionTrace({
                stage: "CREATE_ROOM_AUTHORIZATION",
                decision: "REJECT",
                reason: "No authenticated Telegram identity on socket",
                caller: "RoomLobbyBridge._handleCreateRoom",
                nextAction: "Emit roomError",
                socketId
            });
            this._emitRoomError(
                socketId,
                LOBBY_ERROR_CODES.ROOM_CREATION_REQUIRES_TELEGRAM
            );

            return;

        }

        // R17.9T.6-C — one active created room per Telegram user. Multiple
        // sockets/devices remain allowed; only creation is limited. JOIN_ROOM
        // is unaffected by this quota.
        const existingActiveRoomId = this._activeRoomsByTelegramUser.get(
            creatorTelegramUserId
        ) ?? null;

        if (existingActiveRoomId != null) {

            this._logger.decisionTrace({
                stage: "CREATE_ROOM_AUTHORIZATION",
                decision: "REJECT",
                reason: `Telegram user already owns active room ${existingActiveRoomId}`,
                caller: "RoomLobbyBridge._handleCreateRoom",
                nextAction: "Emit roomError",
                socketId,
                // R17.9T.8 — safe numeric identity marker for aggregation.
                // Never initData, tokens, or HMAC values.
                telegramUserId: creatorTelegramUserId
            });

            this._metricsService?.increment("rooms.create_rejected_user_limit");

            this._emitRoomError(
                socketId,
                LOBBY_ERROR_CODES.ROOM_CREATION_USER_LIMIT
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

            // R17.9T.8 — saturation observability: structured trace + counter
            // for ROOM_CREATION_LIMIT occurrences (passive; rejection unchanged).
            this._logger.decisionTrace({
                stage: "CREATE_ROOM_SATURATION",
                decision: "REJECT",
                reason: "Global concurrent room limit reached",
                caller: "RoomLobbyBridge._handleCreateRoom",
                nextAction: "Emit roomError",
                socketId,
                activeRooms: this._roomManager.getActiveRoomCount(),
                maxRooms: this._roomManager.getMaxConcurrentRooms()
            });

            this._metricsService?.increment("rooms.create_rejected_room_limit");

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

            this._releaseTelegramQuota(room.roomId);

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

            this._releaseTelegramQuota(room.roomId);

            this._roomManager.destroyRoom(room.roomId);

            this._emitRoomError(socketId, LOBBY_ERROR_CODES.UNKNOWN_ERROR);

            return;

        }

        this._playerManager.updateRuntime(playerId, {
            roomId: room.roomId
        });

        this._roomCreators.set(room.roomId, playerId);

        // R17.9T.6-C — occupy the Telegram creation quota for this room.
        this._activeRoomsByTelegramUser.set(
            creatorTelegramUserId,
            room.roomId
        );

        const recoveryCredential = this.issueRecoveryCredential(
            playerId,
            room.roomId
        );

        this._logger.info(
            `Lobby room created | roomId=${room.roomId} | playerId=${playerId}`
            + ` | tgId=${creatorTelegramUserId}`
        );

        // R17.9T.8 — passive creation counter (velocity derivable from deltas).
        this._metricsService?.increment("rooms.created");

        this._emitPlayerJoined(room.roomId, playerId);

        const roomSnapshot = this._roomManager.getRoom(room.roomId);

        const roomCreatedPayload = {
            roomId: roomSnapshot.roomId,
            playerId,
            recoveryCredential,
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

    // R20 — Authoritative one-time room network selection.
    //
    // Authorization is fully server-side:
    //   1. The socket's player identity comes from the server-owned
    //      socket→player binding (never from the client payload).
    //   2. The room comes from that authoritative player binding.
    //   3. The requester must be exactly _roomCreators.get(roomId).
    // The client payload carries ONLY the requested network; any ownership
    // claim (playerId / telegramUserId / ownerPlayerId / roomId) is ignored.
    _handleSelectRoomNetwork(socketId, requestedNetwork) {

        const context = this._assertAuthoritativeMutation(
            socketId,
            "selectRoomNetwork"
        );

        if (!context) {

            return;

        }

        const { playerId, roomId } = context;

        const creatorId = this._roomCreators.get(roomId) ?? null;

        if (creatorId == null || creatorId !== playerId) {

            this._logger.decisionTrace({
                stage: "ROOM_NETWORK_SELECTION",
                decision: "REJECT",
                reason: "Requester is not the authoritative room owner",
                caller: "RoomLobbyBridge._handleSelectRoomNetwork",
                nextAction: "Emit roomError",
                roomId,
                playerId,
                socketId
            });

            this._emitRoomError(
                socketId,
                LOBBY_ERROR_CODES.ROOM_NETWORK_SELECT_FORBIDDEN
            );

            return;

        }

        // Strict normalization: only "testnet" | "mainnet" are valid values.
        const network = typeof requestedNetwork === "string"
            ? requestedNetwork.trim().toLowerCase()
            : "";

        if (network !== "testnet" && network !== "mainnet") {

            this._logger.decisionTrace({
                stage: "ROOM_NETWORK_SELECTION",
                decision: "REJECT",
                reason: "Malformed requested network value",
                caller: "RoomLobbyBridge._handleSelectRoomNetwork",
                nextAction: "Emit roomError",
                roomId,
                playerId,
                socketId
            });

            this._emitRoomError(
                socketId,
                LOBBY_ERROR_CODES.ROOM_NETWORK_INVALID
            );

            return;

        }

        // One-time selection: the committed network is immutable for the
        // lifetime of the room. Switching (or re-selecting) is rejected.
        if (this._roomNetworkByRoom.has(roomId)) {

            this._logger.decisionTrace({
                stage: "ROOM_NETWORK_SELECTION",
                decision: "REJECT",
                reason: "Room network already selected",
                caller: "RoomLobbyBridge._handleSelectRoomNetwork",
                nextAction: "Emit roomError",
                roomId,
                playerId,
                socketId,
                network: this._roomNetworkByRoom.get(roomId)
            });

            this._emitRoomError(
                socketId,
                LOBBY_ERROR_CODES.ROOM_NETWORK_ALREADY_SELECTED
            );

            return;

        }

        // R22 — a MAINNET selection arms the cross-runtime handoff BEFORE the
        // authoritative commit (atomicity): if handoff creation fails, the
        // room is NOT committed to MAINNET, no success broadcast is emitted,
        // no handoffId is exposed, and the existing controlled error path is
        // used. The one-time selection is not consumed, so the Owner may
        // retry. A TESTNET selection never creates any handoff material.
        let handoff = null;

        if (network === "mainnet") {

            const handoffStore = this._roomNetworkHandoffStore ?? null;

            if (handoffStore) {

                handoff = this._createRoomNetworkHandoff(roomId, handoffStore);

                if (!handoff) {

                    this._logger.decisionTrace({
                        stage: "ROOM_NETWORK_SELECTION",
                        decision: "REJECT",
                        reason: "RoomNetworkHandoff creation failed",
                        caller: "RoomLobbyBridge._handleSelectRoomNetwork",
                        nextAction: "Emit controlled roomError; MAINNET not committed",
                        roomId,
                        playerId,
                        socketId,
                        network
                    });

                    this._emitRoomError(
                        socketId,
                        LOBBY_ERROR_CODES.UNKNOWN_ERROR
                    );

                    return;

                }

            } else {

                // R20-compatible runtime without the handoff store (partial
                // harnesses): keep the legacy behavior — commit and broadcast
                // only, no handoff continuation armed. Production
                // WheelWinServer always wires the single shared store.
                this._logger.warn(
                    "[RoomLobbyBridge] ROOM_NETWORK_HANDOFF | store not " +
                    "configured; MAINNET handoff not armed"
                );

            }

        }

        this._roomNetworkByRoom.set(roomId, network);

        this._logger.decisionTrace({
            stage: "ROOM_NETWORK_SELECTION",
            decision: "ACCEPT",
            reason: `Room network committed: ${network}`,
            caller: "RoomLobbyBridge._handleSelectRoomNetwork",
            nextAction: "Broadcast ROOM_NETWORK_SELECTED and room state",
            roomId,
            playerId,
            socketId,
            network
        });

        // Authoritative broadcast to every socket currently in the room.
        // Safe lobby information only: roomId + selected network. No Telegram
        // identity, no recovery credentials, no secrets, and — per R22 —
        // never the opaque handoffId.
        this._deliverToRoom(
            roomId,
            LOBBY_SERVER_EVENTS.ROOM_NETWORK_SELECTED,
            {
                roomId,
                network
            }
        );

        this._broadcastRoomState(roomId);

        // R22 — Owner-only opaque handoff continuation, delivered strictly to
        // the verified Owner's authenticated socket. It is never part of the
        // room-wide ROOM_NETWORK_SELECTED broadcast and is never sent to
        // joiners or spectators.
        if (handoff) {

            this._deliverRoomNetworkHandoffReady(roomId, creatorId, handoff);

        }

    }

    /**
     * R23 — Mainnet bootstrap from the R22 cross-runtime handoff.
     *
     * Server-authoritative entry point for the authenticated Owner of a
     * Testnet MAINNET-selected room who has opened the Mainnet runtime:
     *
     *   authenticated socket (Telegram initData, io.use middleware)
     *     → claim(handoffId, ownerTelegramUserId) via RoomNetworkHandoffClient
     *     → NEW ordinary Mainnet Room via the EXISTING _handleCreateRoom path
     *     → complete(handoffId, ownerTelegramUserId, newMainnetRoomId)
     *     → Owner-only { roomId, network: "mainnet" } result
     *
     * Identity comes ONLY from the trusted Telegram socket context (the same
     * resolver that authorizes CREATE_ROOM). The handoffId is a continuation
     * token, never an identity proof. Client-supplied roomId / playerId /
     * ownerTelegramUserId / network / mainnetRoomId are never accepted. The
     * Testnet Room is never migrated, copied, socket-bound or destroyed here.
     *
     * Failure semantics (never fabricated success, no destructive rollback):
     * - claim fails → no Mainnet Room is created; controlled error;
     * - claim ok but room creation fails → the existing CREATE_ROOM path has
     *   already delivered its controlled roomError; complete is never called
     *   with a fabricated room;
     * - room created but complete fails → the room stays a normal
     *   authoritative room; a RETRY_REQUIRED error is delivered and the
     *   handoffId → roomId mapping is kept so a retry reuses the SAME room
     *   (no duplicate rooms).
     */
    async _handleRoomNetworkHandoffBootstrap(socketId, rawHandoffId) {

        // Only an opaque string is accepted. No client field other than the
        // handoffId is ever consulted for identity, room or ownership.
        const handoffId = typeof rawHandoffId === "string"
            ? rawHandoffId.trim()
            : "";

        if (handoffId.length === 0 || handoffId.length > 512) {

            this._emitRoomError(
                socketId,
                LOBBY_ERROR_CODES.ROOM_NETWORK_HANDOFF_BOOTSTRAP_INVALID
            );

            return;

        }

        // R23 — the Mainnet runtime trusts ONLY fresh Telegram
        // authentication. The identity is resolved from the authenticated
        // socket context exactly like CREATE_ROOM does; a bootstrap request
        // without an authenticated Telegram identity is rejected fail-closed
        // with the established lobby error code.
        const ownerTelegramUserId = this._resolveSocketTelegramUserId(socketId);

        if (ownerTelegramUserId == null) {

            this._emitRoomError(
                socketId,
                LOBBY_ERROR_CODES.ROOM_CREATION_REQUIRES_TELEGRAM
            );

            return;

        }

        const handoffClient = this._roomNetworkHandoffClient ?? null;

        if (!handoffClient) {

            this._logger.warn(
                "[RoomLobbyBridge] ROOM_NETWORK_HANDOFF_BOOTSTRAP | client " +
                "not configured; bootstrap rejected"
            );

            this._emitRoomError(
                socketId,
                LOBBY_ERROR_CODES.ROOM_NETWORK_HANDOFF_BOOTSTRAP_UNAVAILABLE
            );

            return;

        }

        // Idempotency: ONE handoff → AT MOST ONE Mainnet Room. If this
        // runtime already created the room for this handoff, never create a
        // second one; reuse the authoritative room and re-attempt the
        // completion.
        const mappedRoomId =
            this._roomNetworkHandoffRoomByHandoff.get(handoffId) ?? null;

        if (mappedRoomId) {

            if (!this._roomManager.getRoom(mappedRoomId)) {

                // The previously created room no longer exists (destroyed
                // through the normal lifecycle). A new room must NOT be
                // created for the same handoff; the handoff can no longer be
                // served by this runtime.
                this._logger.decisionTrace({
                    stage: "ROOM_NETWORK_HANDOFF_BOOTSTRAP",
                    decision: "REJECT",
                    reason: "Mapped Mainnet room no longer exists",
                    caller: "RoomLobbyBridge._handleRoomNetworkHandoffBootstrap",
                    nextAction: "Emit controlled roomError",
                    roomId: mappedRoomId,
                    socketId
                });

                this._emitRoomError(
                    socketId,
                    LOBBY_ERROR_CODES.ROOM_NETWORK_HANDOFF_BOOTSTRAP_INVALID
                );

                return;

            }

            try {

                const claimResult = await handoffClient.claim({
                    handoffId,
                    ownerTelegramUserId
                });

                if (!claimResult?.ok) {

                    this._logBootstrapClaimFailure(
                        claimResult?.reason,
                        socketId
                    );

                    this._emitRoomError(
                        socketId,
                        this._bootstrapClaimErrorCode(claimResult?.reason)
                    );

                    return;

                }

                // Defensive consistency check: the store's completed record
                // must agree with the runtime mapping (cannot happen in
                // normal ordering; logged server-side only).
                if (
                    claimResult.state === "completed"
                    && claimResult.mainnetRoomId
                    && claimResult.mainnetRoomId !== mappedRoomId
                ) {

                    this._logger.warn(
                        "[RoomLobbyBridge] ROOM_NETWORK_HANDOFF_BOOTSTRAP | " +
                        "store completed mainnetRoomId disagrees with the " +
                        "runtime mapping; the runtime room stays authoritative"
                    );

                }

                const completeResult = await handoffClient.complete({
                    handoffId,
                    ownerTelegramUserId,
                    mainnetRoomId: mappedRoomId
                });

                if (!completeResult?.ok) {

                    this._logBootstrapCompleteFailure(
                        completeResult?.reason,
                        socketId
                    );

                    this._emitRoomError(
                        socketId,
                        LOBBY_ERROR_CODES
                            .ROOM_NETWORK_HANDOFF_BOOTSTRAP_RETRY_REQUIRED
                    );

                    return;

                }

                this._deliverRoomNetworkHandoffBootstrapResult(
                    socketId,
                    mappedRoomId
                );

            } catch (error) {

                this._logBootstrapUnexpectedError(error, socketId);

                this._emitRoomError(
                    socketId,
                    LOBBY_ERROR_CODES.UNKNOWN_ERROR
                );

            }

            return;

        }

        // Fresh bootstrap: the socket must not already be bound to a player.
        // (An idempotent retry of a mapped handoff is handled above and never
        // reaches this point.) The existing CREATE_ROOM admission would
        // reject this anyway; failing here avoids consuming claim state for
        // a creation that cannot happen.
        if (this._socketToPlayer.has(socketId)) {

            this._emitRoomError(
                socketId,
                LOBBY_ERROR_CODES.PLAYER_ALREADY_CONNECTED
            );

            return;

        }

        try {

            const claimResult = await handoffClient.claim({
                handoffId,
                ownerTelegramUserId
            });

            if (!claimResult?.ok) {

                this._logBootstrapClaimFailure(claimResult?.reason, socketId);

                this._emitRoomError(
                    socketId,
                    this._bootstrapClaimErrorCode(claimResult?.reason)
                );

                return;

            }

            // The handoff may already be completed on the Testnet side (e.g.
            // a Mainnet restart dropped the local mapping after a successful
            // completion). The authoritative Mainnet room of that completion
            // is reused when it still exists; no second room is created.
            if (
                claimResult.state === "completed"
                && claimResult.mainnetRoomId
            ) {

                const completedRoomId = claimResult.mainnetRoomId;

                if (this._roomManager.getRoom(completedRoomId)) {

                    this._roomNetworkHandoffRoomByHandoff.set(
                        handoffId,
                        completedRoomId
                    );

                    this._deliverRoomNetworkHandoffBootstrapResult(
                        socketId,
                        completedRoomId
                    );

                } else {

                    this._logger.decisionTrace({
                        stage: "ROOM_NETWORK_HANDOFF_BOOTSTRAP",
                        decision: "REJECT",
                        reason:
                            "Completed handoff room no longer exists on this runtime",
                        caller:
                            "RoomLobbyBridge._handleRoomNetworkHandoffBootstrap",
                        nextAction: "Emit controlled roomError",
                        socketId
                    });

                    this._emitRoomError(
                        socketId,
                        LOBBY_ERROR_CODES.ROOM_NETWORK_HANDOFF_BOOTSTRAP_INVALID
                    );

                }

                return;

            }

            // Create the NEW ordinary Mainnet Room through the EXISTING
            // authoritative CREATE_ROOM path (per-socket dedup, Telegram
            // admission, one-active-room-per-user quota, drain gate, capacity,
            // RoomManager rules, room id generation, creator mapping and
            // socket/player binding). No privileged "handoff room" exists.
            this._handleCreateRoom(socketId);

            const createdRoomId =
                this._getSocketContext(socketId)?.roomId ?? null;

            if (!createdRoomId) {

                // The create path already emitted its own controlled
                // roomError (e.g. quota, drain, capacity). Complete is never
                // called with a fabricated room.
                this._logger.decisionTrace({
                    stage: "ROOM_NETWORK_HANDOFF_BOOTSTRAP",
                    decision: "REJECT",
                    reason: "Mainnet room creation failed",
                    caller: "RoomLobbyBridge._handleRoomNetworkHandoffBootstrap",
                    nextAction:
                        "Existing CREATE_ROOM error already delivered; no complete call",
                    socketId
                });

                return;

            }

            // Idempotency mapping is recorded BEFORE the completion so a
            // failure (or runtime crash) between creation and completion
            // still resolves to the SAME room on retry.
            this._roomNetworkHandoffRoomByHandoff.set(
                handoffId,
                createdRoomId
            );

            const completeResult = await handoffClient.complete({
                handoffId,
                ownerTelegramUserId,
                mainnetRoomId: createdRoomId
            });

            if (!completeResult?.ok) {

                // The created room stays a normal authoritative room. No
                // destructive rollback is invented; the retry path reuses
                // the mapped room and re-attempts completion.
                this._logBootstrapCompleteFailure(
                    completeResult?.reason,
                    socketId
                );

                this._emitRoomError(
                    socketId,
                    LOBBY_ERROR_CODES.ROOM_NETWORK_HANDOFF_BOOTSTRAP_RETRY_REQUIRED
                );

                return;

            }

            this._deliverRoomNetworkHandoffBootstrapResult(
                socketId,
                createdRoomId
            );

        } catch (error) {

            this._logBootstrapUnexpectedError(error, socketId);

            this._emitRoomError(
                socketId,
                LOBBY_ERROR_CODES.UNKNOWN_ERROR
            );

        }

    }

    /**
     * R23 — deliver the bootstrap result to the authenticated Owner socket
     * ONLY. Payload: { roomId, network: "mainnet" } exactly — no handoff
     * internals, no claim state, no Telegram identity, no Testnet room id,
     * no secret material.
     */
    _deliverRoomNetworkHandoffBootstrapResult(socketId, roomId) {

        this._deliverToSocket(
            socketId,
            LOBBY_SERVER_EVENTS.ROOM_NETWORK_HANDOFF_BOOTSTRAP_RESULT,
            {
                roomId,
                network: "mainnet"
            }
        );

    }

    /**
     * R23 — coarse client error code for a failed claim. Transport and
     * configuration failures are retryable; identity and record failures
     * are not. The precise cross-runtime reason never reaches the browser.
     */
    _bootstrapClaimErrorCode(claimReason) {

        const reason = String(claimReason ?? "");

        if (
            reason === "HANDOFF_CLIENT_NOT_CONFIGURED"
            || reason === "TIMEOUT"
            || reason === "NETWORK_ERROR"
            || reason === "UNEXPECTED_RESPONSE"
            || reason.startsWith("HTTP_")
        ) {

            return LOBBY_ERROR_CODES.ROOM_NETWORK_HANDOFF_BOOTSTRAP_UNAVAILABLE;

        }

        return LOBBY_ERROR_CODES.ROOM_NETWORK_HANDOFF_BOOTSTRAP_INVALID;

    }

    /**
     * R23 — server-side precise failure logging. The handoffId is never
     * logged; the precise R21 contract reason stays in server logs only.
     */
    _logBootstrapClaimFailure(reason, socketId) {

        this._logger.warn(
            "[RoomLobbyBridge] ROOM_NETWORK_HANDOFF_BOOTSTRAP | claim " +
            `failed | reason=${reason ?? "unknown"} | socketId=${socketId}`
        );

    }

    _logBootstrapCompleteFailure(reason, socketId) {

        this._logger.warn(
            "[RoomLobbyBridge] ROOM_NETWORK_HANDOFF_BOOTSTRAP | complete " +
            `failed | reason=${reason ?? "unknown"} | socketId=${socketId}`
        );

    }

    _logBootstrapUnexpectedError(error, socketId) {

        this._logger.error(
            "[RoomLobbyBridge] ROOM_NETWORK_HANDOFF_BOOTSTRAP | unexpected " +
            "error | error="
            + (error instanceof Error ? error.message : String(error))
            + ` | socketId=${socketId}`
        );

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

        const recoveryCredential = this.issueRecoveryCredential(
            playerId,
            roomId
        );

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
                recoveryCredential,
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

        const stage = roomId
            ? (this._continueToVerifyByRoom.has(roomId)
                ? "VERIFY_COMPLETED"
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
     * Issue a server-owned recovery credential for a player seat.
     * Plaintext is returned once for private delivery to the owner socket.
     */
    issueRecoveryCredential(playerId, roomId) {

        return this._recoveryCredentials.issue(playerId, roomId);

    }

    /**
     * Validate a recovery credential before any seat rebind / soft transfer.
     */
    authorizeRecoveryCredential({
        playerId = null,
        roomId = null,
        credential = null
    } = {}) {

        return this._recoveryCredentials.validate({
            playerId,
            roomId,
            credential
        });

    }

    /**
     * Rebind a socket for Setup Session or Game Session recovery.
     * Identity is resolved exclusively from server-owned recovery ownership.
     * Setup reconnect never restarts the timer / session.
     *
     * R13.1E — playerId claims require a valid recovery credential first.
     */
    reconnectSession(socketId, claim = null) {

        this._lastRecoveryDenial = null;

        const previousSocketId = claim?.playerId
            ? this.getRecoveryOwnershipDebug(claim.playerId).previousSocketId
            : null;

        const credential = claim?.recoveryCredential
            ?? claim?.recoveryToken
            ?? null;

        const credentialPresent = typeof credential === "string"
            && credential.length > 0;

        this._logger.info(
            `[R6.2A Recovery] authorization begin`
            + ` | roomId=${claim?.roomId ?? "null"}`
            + ` | playerId=${claim?.playerId ?? "null"}`
            + ` | socket.id=${socketId ?? "null"}`
            + ` | previousSocket.id=${previousSocketId ?? "null"}`
            + ` | credentialPresent=${credentialPresent}`
        );

        if (claim?.playerId) {

            const auth = this.authorizeRecoveryCredential({
                playerId: claim.playerId,
                roomId: claim.roomId ?? null,
                credential
            });

            this._logger.info(
                `[R13.1E Recovery] credential validation`
                + ` | result=${auth.ok ? "pass" : "fail"}`
                + ` | reason=${auth.ok ? "ok" : auth.reason}`
                + ` | credentialPresent=${credentialPresent}`
                + ` | requestedPlayerId=${claim.playerId}`
                + ` | requestedRoomId=${claim.roomId ?? "null"}`
                + ` | socket.id=${socketId ?? "null"}`
            );

            if (!auth.ok) {

                this._denyRecoveryIdentity(
                    "Recovery identity is not authorized for this socket",
                    {
                        playerId: claim.playerId,
                        roomId: claim.roomId ?? null,
                        socketId,
                        authReason: auth.reason
                    }
                );

                this._logger.info(
                    `[R6.2A Recovery] reclaim failure`
                    + ` | roomId=${claim?.roomId ?? "null"}`
                    + ` | playerId=${claim?.playerId ?? "null"}`
                    + ` | socket.id=${socketId ?? "null"}`
                    + ` | previousSocket.id=${previousSocketId ?? "null"}`
                    + ` | reason=${auth.reason}`
                );

                return {
                    ok: false,
                    reason: "Recovery identity is not authorized for this socket"
                };

            }

        }

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

        // Setup-only recovery while prep pages run. After VERIFY_COMPLETED
        // (Page5), fall through to RecoveryEngine even if the Setup Timer remains.
        const setupActive = setupRecoverable
            ;

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
        // continueToVerify progress and does not strand the client on Verify.
        if (this._profilesRevealedByRoom.has(roomId)) {

            this._deliverToSocket(
                socketId,
                LOBBY_SERVER_EVENTS.VERIFY_COMPLETED,
                {
                    roomId,
                    players: this._buildPlayerList(room)
                }
            );

        }

        if (this._continueToVerifyByRoom.has(roomId)) {

            const gameStart = this._gameStartAuthorization
                ?.getReconnectSnapshot?.(roomId);

            if (!gameStart) {

                this._deliverToSocket(
                    socketId,
                    LOBBY_SERVER_EVENTS.PAYMENT_STAGE_READY,
                    {
                        roomId,
                        paymentAcceptanceEnabled: LIVE_PAYMENT_ACCEPTANCE_ENABLED
                    }
                );

                this._deliverPaymentStatusToSocket(roomId, playerId, socketId);

            }

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
                            authorizedAt: gameStart.authorizedAt
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

                if (gameStart.phase === "OPEN_PAGE5") {

                    this._deliverToSocket(
                        socketId,
                        LOBBY_SERVER_EVENTS.OPEN_PAGE5,
                        { roomId }
                    );

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

        // R8.6 — After GAME_INITIALIZED Setup expiry must not close the room
        // or tear down gameplay/financial bindings.
        if (this._setupSessionLifecycle?.isGameplayOwnershipReleased?.(roomId)) {

            this._logger.info(
                `Lobby ignored SETUP_SESSION_EXPIRED after gameplay init | roomId=${roomId}`
            );

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

            this._roomNetworkByRoom.delete(roomId);

            this._releaseRoomNetworkHandoff(roomId);

            this._releaseTelegramQuota(roomId);

            this._startedRooms.delete(roomId);

            this._clearVerifyBarrier(roomId);

            this._gameplayContextResolver?.deactivateRoomGame(roomId);

            return;

        }

        void this._closeRoom(roomId, "setup_expired");

    }

    _handleGameCreated({ gameId, roomId }) {

        if (!gameId || !roomId) {

            return;

        }

        // R1.1 — startGame (Page2 entry) fires at game prep / room-full,
        // not at GAME_INITIALIZED (which now waits for verify barrier).
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

        const socketId = this._playerToSocket.get(playerId);

        const creatorId = this._roomCreators.get(roomId);

        const gameStarted = this._startedRooms.has(roomId);

        // R13.1B — After GAME_INITIALIZED, explicit LEAVE_ROOM is soft-offline
        // until Result Session (Page6) allows per-player FINISH / terminal empty close.
        // Do not remove seats or destroy the room during active gameplay.
        if (
            gameStarted
            && this._isActiveGameplayProtected(roomId)
            && !this._isTerminalResultLeaveAllowed(roomId)
        ) {

            this._softLeaveActiveGameplay(playerId, roomId, {
                socketId,
                notifyPlayer,
                reason
            });

            return;

        }

        this._clearRecoveryOwnershipForPlayer(playerId);

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

            void this._closeRoom(roomId, "creator_left");

            return;

        }

        // C4.9 / R7.70C20 / R13.1B — Deliberate leave after Result Session
        // (Page6 FINISH) is per-player. Room-wide close remains Result Session
        // timeout or last Page6 leave — never mid-gameplay empty-room destroy.
        if (gameStarted) {

            console.log("======================================================");
            console.log("SOCKET BRANCH: gameStarted (per-player leave)");
            console.log({
                Timestamp: new Date().toISOString(),
                RoomId: roomId,
                PlayerId: playerId,
                SocketId: socketId ?? null,
                GameStarted: gameStarted,
                DisconnectReason: reason ?? null
            });
            console.trace("RoomLobbyBridge._removePlayerFromLobby gameStarted leave");
            console.log("======================================================");

            const room = this._roomManager.getRoom(roomId);

            if (!room) {

                this._cleanupPlayer(playerId);

                if (socketId) {

                    this._unregisterSocket(socketId);

                }

                return;

            }

            this._roomManager.removePlayer(roomId, playerId, { allowLocked: true });

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
                `Lobby per-player leave (started) | roomId=${roomId} `
                + `| playerId=${playerId} | reason=${reason}`
            );

            const remainingRoom = this._roomManager.getRoom(roomId);

            if (!remainingRoom || remainingRoom.players.length === 0) {

                // R13.1B — never treat empty seats as destroy during active gameplay.
                if (
                    this._isActiveGameplayProtected(roomId)
                    && !this._isTerminalResultLeaveAllowed(roomId)
                ) {

                    this._logger.info(
                        `Lobby refused empty-room finish during active gameplay`
                        + ` | roomId=${roomId}`
                    );

                    return;

                }

                registerRoomDestroyContext(roomId, {
                    reason: "empty_room_after_result_leave",
                    caller: "RoomLobbyBridge._removePlayerFromLobby",
                    triggerEvent: "PLAYER_LEFT_EMPTY_STARTED_ROOM",
                    currentGameStage: "RESULT"
                });

                // Last player left Page6 — close via single SESSION_FINISHED path.
                this._finishResultSession(roomId, "session_ended");

                return;

            }

            this._broadcastRoomState(roomId);

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
                currentGameStage: this._continueToVerifyByRoom.has(roomId)
                    ? "VERIFY_COMPLETED"
                    : "SETUP"
            });

            this._roomManager.destroyRoom(roomId);

        // Archive asynchronously after the authoritative room destruction.
        // Cloudflare errors must never delay cleanup or escape as unhandled rejections.
        const forensicArchiveService = this._forensicArchiveService;
        if (forensicArchiveService) {
            Promise.resolve()
                .then(() => forensicArchiveService.ensureArchivedAndUploaded({
                    roomId,
                    gameId,
                    reason: reason ?? "room_destroyed"
                }))
                .catch((error) => {
                    try {
                        this._logger?.error?.(
                            `FORENSIC_ARCHIVE_ASYNC_FAILED | roomId=${roomId} | error=${error?.message ?? error}`
                        );
                    } catch {
                        // Logging failures must not affect gameplay cleanup.
                    }
                });
        }


            this._roomCreators.delete(roomId);

            this._roomNetworkByRoom.delete(roomId);

            this._releaseRoomNetworkHandoff(roomId);

            this._releaseTelegramQuota(roomId);

            return;

        }

        this._broadcastRoomState(roomId);

    }

    /**
     * R13.1B — Active gameplay ownership after GAME_INITIALIZED.
     * Setup ownership release and GameManager initialized status are authoritative;
     * socket/online counts are not.
     */
    _isActiveGameplayProtected(roomId) {

        if (!roomId) {

            return false;

        }

        if (this._setupSessionLifecycle?.isGameplayOwnershipReleased?.(roomId) === true) {

            return true;

        }

        return this._resolveGameManager()?.hasInitializedGameplay?.(roomId) === true;

    }

    /**
     * R13.1B — Page6 / Result Session linger may remove seats and finish empty rooms.
     */
    _isTerminalResultLeaveAllowed(roomId) {

        return this._resultSessionLifecycle?.isActive?.(roomId) === true;

    }

    _resolveGameManager() {

        return this._gameStartAuthorization?._gameManager
            ?? null;

    }

    /**
     * R13.1B — Explicit leave during active gameplay reuses soft-disconnect
     * abandonment: seat + identity remain; player goes offline; game continues.
     */
    _softLeaveActiveGameplay(playerId, roomId, {
        socketId = null,
        notifyPlayer = false,
        reason = "left"
    } = {}) {

        this._logger.decisionTrace({
            stage: "LEAVE_ROOM",
            decision: "SOFT_LEAVE_ACTIVE_GAME",
            reason: reason ?? "left",
            caller: "RoomLobbyBridge._softLeaveActiveGameplay",
            nextAction: "Keep seat / continue gameplay",
            roomId,
            playerId
        });

        if (socketId) {

            this._stashRecoveryOwnership(socketId, {
                playerId,
                roomId
            });

        }

        this._playerManager.setConnectionState(
            playerId,
            CONNECTION_STATE.DISCONNECTED
        );

        if (socketId) {

            this._deliverSocketLeaveRoom(socketId);

            if (notifyPlayer) {

                this._deliverToSocket(
                    socketId,
                    LOBBY_SERVER_EVENTS.ROOM_LEFT,
                    { roomId, playerId }
                );

            }

        }

        this._logger.info(
            `Lobby soft leave during active gameplay | roomId=${roomId}`
            + ` | playerId=${playerId} | reason=${reason}`
        );

    }

    /**
     * R6.5 / R12.5I / R13.1B — Authoritative Result Session / room cleanup path.
     * Used when the server Result Session expires (or equivalent session end).
     * Client Page6 FINISH navigates locally via LEAVE_ROOM and does not wait
     * for this path. Broadcasts SESSION_FINISHED while sockets are still
     * joined, then closes the room.
     *
     * session_ended from empty-room leave is refused while active gameplay is
     * protected and Result Session has not started (Page6).
     */
    _finishResultSession(roomId, reason) {

        if (!roomId) {

            return;

        }

        if (
            reason === "session_ended"
            && this._isActiveGameplayProtected(roomId)
            && !this._isTerminalResultLeaveAllowed(roomId)
        ) {

            this._logger.info(
                `Lobby refused SESSION_FINISHED(session_ended) during active gameplay`
                + ` | roomId=${roomId}`
            );

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

        page6LifecycleDiag(this._logger, "FINISH_RESULT_SESSION", {
            roomId,
            gameId,
            reason: reason ?? "result_session_finished",
            resultSessionExpiresAt: Number.isFinite(activeSession?.expiresAt)
                ? activeSession.expiresAt
                : null,
            serverNow: Date.now(),
            roomPlayerCount: room.players?.length ?? 0
        });

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

        void this._closeRoom(roomId, reason);

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

    configureForensicArchiveService(service) {
        this._forensicArchiveService = service ?? null;
    }

    async _closeRoom(roomId, reason) {

        const room = this._roomManager.getRoom(roomId);

        console.log("======================================================");
        console.log("ROOM CLOSED FROM SOCKET (RoomLobbyBridge._closeRoom)");
        console.log({
            Timestamp: new Date().toISOString(),
            RoomId: roomId,
            Reason: reason ?? null,
            CurrentStage: this._continueToVerifyByRoom.has(roomId)
                ? "VERIFY_COMPLETED"
                : this._profilesRevealedByRoom.has(roomId)
                    ? "VERIFY"
                    : "SETUP",
            RoomPlayerCount: room?.players.length ?? 0
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

        const playerIds = [...room.players];

        this._recoveryCredentials.invalidateRoom(roomId);

        this._resultSessionLifecycle?.cancel(roomId);

        const gameId = this._gameplayContextResolver?.resolveGameIdByRoomId?.(roomId)
            ?? null;

        const setupSnapshot = this._setupSessionLifecycle?.buildSyncPayload?.(roomId)
            ?? null;

        registerRoomDestroyContext(roomId, {
            reason: reason ?? "unspecified",
            caller: "RoomLobbyBridge._closeRoom",
            triggerEvent: reason ?? "ROOM_CLOSE",
            gameId,
            currentGameStage: this._continueToVerifyByRoom.has(roomId)
                ? "VERIFY_COMPLETED"
                : this._profilesRevealedByRoom.has(roomId)
                    ? "VERIFY"
                    : "SETUP",
            setupSession: setupSnapshot?.state ?? null,
            socketCount: playerIds.filter(
                (playerId) => Boolean(this._playerToSocket.get(playerId))
            ).length
        });

        this._roomManager.destroyRoom(roomId);

        this._roomCreators.delete(roomId);

        this._roomNetworkByRoom.delete(roomId);

        this._releaseRoomNetworkHandoff(roomId);

        this._releaseTelegramQuota(roomId);

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
            state: room.status,
            // R20 — authoritative room network. null while the Owner's
            // one-time testnet/mainnet selection is still pending.
            network: this._roomNetworkByRoom.get(room.roomId) ?? null
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
        // crypto/matrix fields stay hidden until VERIFY_COMPLETED.
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
        // without leaking color/arrangement or private crypto/matrix fields.
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

    _handleVerifyNextRequest(socketId) {

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

        let continued = this._continueToVerifyByRoom.get(roomId);

        if (!continued) {

            continued = new Set();

            this._continueToVerifyByRoom.set(roomId, continued);

        }

        if (continued.has(playerId)) {

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

        this._completeVerifyBarrier(roomId);

    }


    _completeVerifyBarrier(roomId) {

        if (this._verifyBarrierCompletedByRoom.has(roomId)) {

            return;

        }

        this._verifyBarrierCompletedByRoom.add(roomId);

        const room = this._roomManager.getRoom(roomId);

        if (!room
            || room.maxPlayers !== 3
            || room.players.length !== 3
            || new Set(room.players).size !== 3) {

            void this._closeRoom(roomId, "invalid_payment_roster");

            return;

        }

        // Keep the existing setup deadline armed while Page4 is active. It
        // remains the authority that closes an unpaid room.
        const archivedSetup = this._setupSessionLifecycle
            ?.archiveForPayment?.(roomId)
            ?? null;

        if (!archivedSetup) {

            void this._closeRoom(roomId, "payment_stage_setup_unavailable");

            return;

        }

        this._deliverToRoom(
            roomId,
            LOBBY_SERVER_EVENTS.SETUP_SESSION_SYNC,
            archivedSetup
        );

        this._deliverToRoom(
            roomId,
            LOBBY_SERVER_EVENTS.PAYMENT_STAGE_READY,
            {
                roomId,
                paymentAcceptanceEnabled: LIVE_PAYMENT_ACCEPTANCE_ENABLED
            }
        );

        for (const playerId of room.players) {

            const socketId = this._playerToSocket.get(playerId);

            if (socketId) {

                this._deliverPaymentStatusToSocket(roomId, playerId, socketId);

            }

        }

        this._logger.info(`Verify barrier complete | roomId=${roomId}`);

        // Trigger the authoritative game start gate.
        this._eventBus.emit({
            source: EVENT_SOURCES.ROOM_LOBBY_BRIDGE,
            type: EVENT_TYPES.VERIFY_BARRIER_COMPLETED,
            payload: {
                roomId,
                paymentAcceptanceEnabled: LIVE_PAYMENT_ACCEPTANCE_ENABLED,
                paymentSessionPrepared: false,
                paymentStatus: LIVE_PAYMENT_ACCEPTANCE_ENABLED
                    ? "PENDING_PREPARATION"
                    : "PAYMENT_UNAVAILABLE"
            }
        });

        this._preparePaymentSessionIfEnabled(roomId, room);

    }

    _deliverPaymentStatusToSocket(roomId, playerId, socketId) {

        // Authoritative identity validation: the room must exist, the player
        // must own the seat, and the socket must be bound to that player. A
        // client claim is never accepted here — only the server-owned binding.
        const room = this._roomManager.getRoom(roomId);

        if (!room
            || !Array.isArray(room.players)
            || !room.players.includes(playerId)) {

            return;
        }

        const boundSocketId = this._playerToSocket.get(playerId);

        if (boundSocketId !== socketId) {

            return;
        }

        const binding = this._paymentApplicationBinding;
        const runtime = binding && binding.runtime ? binding.runtime : null;
        const paymentService = runtime ? runtime.paymentService : null;
        const ledger = runtime ? runtime.ledger : null;

        const failClosed = (reason) => {

            this._deliverToSocket(
                socketId,
                LOBBY_SERVER_EVENTS.ENTRY_PAYMENT_SESSION_UPDATED,
                {
                    roomId,
                    playerId,
                    status: "PAYMENT_UNAVAILABLE",
                    paymentAcceptanceEnabled: LIVE_PAYMENT_ACCEPTANCE_ENABLED,
                    reason: reason || LIVE_PAYMENT_ACCEPTANCE_DISABLED_REASON
                }
            );

        };

        if (!paymentService
            || !ledger
            || typeof paymentService.listPaymentIntentsForRoom !== "function"
            || !ledger.store
            || typeof ledger.store.findByIdempotencyKey !== "function") {

            failClosed("payment_state_unavailable");
            return;
        }

        const intents = paymentService.listPaymentIntentsForRoom(roomId)
            .filter((intent) => intent && intent.playerId === playerId);

        if (intents.length === 0) {

            failClosed(LIVE_PAYMENT_ACCEPTANCE_DISABLED_REASON);
            return;
        }

        if (intents.length > 1) {

            failClosed("payment_state_ambiguous");
            return;
        }

        const intent = intents[0];

        let status = "PAYMENT_UNAVAILABLE";
        let reason = LIVE_PAYMENT_ACCEPTANCE_DISABLED_REASON;

        if (intent.state === PAYMENT_INTENT_STATE.SETTLED) {
            // A settled payment is only authoritative when the durable intent
            // and the matching INCOMING_PRINCIPAL ledger entry satisfy the
            // existing payment rules (same reference, transaction id, amount,
            // room/player and the SETTLED confirmation source).
            const principalKey = `ww:incoming-principal:${intent.paymentReference}`;
            const principalEntry = ledger.store.findByIdempotencyKey(principalKey);

            if (this._isAuthoritativeSettledPrincipal(principalEntry, intent)) {

                status = "SETTLED";
                reason = null;

            } else {

                failClosed("payment_settlement_unverified");
                return;

            }

        } else if (intent.state === PAYMENT_INTENT_STATE.PENDING
            || intent.state === PAYMENT_INTENT_STATE.MATCHED) {

            status = "AWAITING_PAYMENT";
            reason = null;

        } else {

            // Terminal non-settled states (EXPIRED / FAILED / CANCELLED /
            // REFUNDED) must never be reported as a payable or settled state.
            failClosed(`payment_${String(intent.state).toLowerCase()}`);
            return;

        }

        this._deliverToSocket(
            socketId,
            LOBBY_SERVER_EVENTS.ENTRY_PAYMENT_SESSION_UPDATED,
            {
                roomId,
                playerId,
                status,
                paymentAcceptanceEnabled: LIVE_PAYMENT_ACCEPTANCE_ENABLED,
                reason,
                paymentReference: intent.paymentReference,
                amountAtomic: intent.amountAtomic,
                destinationWalletAddress: intent.destinationWalletAddress,
                expiresAt: intent.expiresAt ?? null,
                network: intent.network,
                asset: intent.asset
            }
        );

    }

    /**
     * P6.7 — Re-verify a principal ledger entry against the authoritative
     * settled intent. Mirrors the same rules the payment runtime uses to gate
     * gameplay start, so a reconnect can never report settlement from a client
     * assertion or a stale snapshot.
     */
    _isAuthoritativeSettledPrincipal(entry, intent) {

        if (!entry || entry.kind !== LEDGER_ENTRY_KIND.INCOMING_PRINCIPAL) {

            return false;

        }

        const metadata = entry.metadata ?? null;

        return entry.roomId === intent.roomId
            && entry.playerId === intent.playerId
            && entry.amountAtomic === intent.amountAtomic
            && entry.network === intent.network
            && entry.asset === intent.asset
            && Boolean(metadata)
            && metadata.paymentReference === intent.paymentReference
            && metadata.transactionId === intent.transactionId
            && metadata.intentState === PAYMENT_INTENT_STATE.SETTLED
            && metadata.source === INCOMING_PRINCIPAL_CONFIRMATION_SOURCE;

    }

    /**
     * P6.7 — Narrowly scoped authoritative payment-state re-delivery.
     *
     * Page4 requests its own current payment status after mounting so it never
     * stays stale when the original ENTRY_PAYMENT_SESSION_UPDATED event was
     * emitted while the page was not yet subscribed. Identity is resolved
     * exclusively from the server-owned socket→player binding; no client
     * claim is trusted. The re-delivery is idempotent: it re-derives the same
     * status the reconnect path would have delivered.
     */
    _handlePaymentStatusRequest(socketId) {

        const context = this._getSocketContext(socketId);

        if (!context || !context.playerId || !context.roomId) {

            return;
        }

        this._deliverPaymentStatusToSocket(
            context.roomId,
            context.playerId,
            socketId
        );

    }

    _preparePaymentSessionIfEnabled(roomId, room) {
        const binding = this._paymentApplicationBinding;
        if (!binding || typeof binding.prepareRoomPaymentSession !== "function") {
            return;
        }
        if (!LIVE_PAYMENT_ACCEPTANCE_ENABLED) {
            return;
        }
        if (!room || !Array.isArray(room.players) || room.players.length !== 3) {
            return;
        }

        const uniquePlayers = new Set(room.players);
        if (uniquePlayers.size !== 3) {
            return;
        }

        const paymentRequests = [];
        for (const playerId of room.players) {
            const runtime = this._playerManager.getRuntime?.(playerId);
            const paymentConfig = runtime?.payment ?? runtime?.paymentRequest ?? null;
            if (!paymentConfig || typeof paymentConfig !== "object") {
                return;
            }
            if (typeof paymentConfig.expectedSender !== "string" || paymentConfig.expectedSender.trim() === "") {
                return;
            }
            if (typeof paymentConfig.amountAtomic !== "number" || !Number.isSafeInteger(paymentConfig.amountAtomic) || paymentConfig.amountAtomic <= 0) {
                return;
            }
            if (typeof paymentConfig.paymentReference !== "string" || paymentConfig.paymentReference.trim() === "") {
                return;
            }
            paymentRequests.push({
                playerId,
                paymentReference: paymentConfig.paymentReference.trim(),
                expectedSender: paymentConfig.expectedSender.trim(),
                amountAtomic: paymentConfig.amountAtomic
            });
        }

        if (paymentRequests.length !== 3) {
            return;
        }

        let prepared;
        try {
            prepared = binding.prepareRoomPaymentSession(roomId, paymentRequests);
        } catch (error) {
            this._logger?.warn?.(`Failed to prepare payment session | roomId=${roomId} | error=${error?.message ?? "unknown"}`);
            return;
        }

        if (!prepared || typeof prepared !== "object" || !Array.isArray(prepared.payments)) {
            return;
        }

        for (const payment of prepared.payments) {
            const socketId = this._playerToSocket.get(payment.playerId);
            if (!socketId) {
                continue;
            }
            this._deliverToSocket(
                socketId,
                LOBBY_SERVER_EVENTS.PAYMENT_REQUEST,
                {
                    roomId,
                    playerId: payment.playerId,
                    paymentReference: payment.paymentReference,
                    destination: payment.destinationWalletAddress,
                    amount: payment.amountAtomic,
                    amountAtomic: payment.amountAtomic,
                    asset: payment.asset,
                    network: payment.network,
                    expiresAt: payment.expiresAt ?? null
                }
            );
        }
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
     * P6.7 — after the game start gate validates, navigate to Page5.
     */
    _handleGameStartBootstrapReady(payload) {

        const roomId = payload?.roomId;

        if (!roomId) {

            return;

        }

        this._deliverOpenPage5(roomId);

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

        // Cancel game; audit records stay on the ledger.
        void this._closeRoom(roomId, payload?.reason ?? "game_start_failed");

    }





    /**
     * R1.3D — Development-only shortcut past the verify barrier.
     * Reuses the same VERIFY_BARRIER_COMPLETED → activation path as production.
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

        if (this._startedRooms.has(roomId)) {

            this._eventBus.emit({
                source: EVENT_SOURCES.ROOM_LOBBY_BRIDGE,
                type: EVENT_TYPES.VERIFY_BARRIER_COMPLETED,
                payload: { roomId }
            });

            return;

        }

        // R5.15 — Dev shortcut may skip Page2; seed any incomplete seats so
        // ConfigurationEngine never builds from null defaults.
        this._ensureDebugProfilesReady(roomId);

        this._completeVerifyBarrier(roomId);

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

        // R6.5 / R12.5A — start the authoritative Page6 linger first so the
        // OPEN_PAGE6 socket payload can carry the same expiresAt clients display.
        const resultSession = this._resultSessionLifecycle?.start(roomId, {
            gameId: gameId ?? null
        }) ?? null;

        page6LifecycleDiag(this._logger, "OPEN_PAGE6_DELIVER", {
            roomId,
            gameId: gameId ?? null,
            openPage6: true,
            resultSessionExpiresAt: resultSession?.expiresAt ?? null,
            startedAt: resultSession?.startedAt ?? null,
            durationMs: resultSession?.durationMs ?? null,
            serverNow: Date.now()
        });

        this._deliverToRoom(
            roomId,
            LOBBY_SERVER_EVENTS.OPEN_PAGE6,
            {
                roomId,
                gameId: gameId ?? null,
                expiresAt: resultSession?.expiresAt ?? null,
                startedAt: resultSession?.startedAt ?? null,
                durationMs: resultSession?.durationMs ?? null
            }
        );

    }




    _revealVerifyRoster(roomId, room) {

        this._profilesRevealedByRoom.add(roomId);

        this._eventBus.emit({
            source: EVENT_SOURCES.ROOM_LOBBY_BRIDGE,
            type: EVENT_TYPES.VERIFY_COMPLETED,
            payload: { roomId }
        });

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
            nextAction: "await VERIFY_NEXT → archive()",
            roomId
        });

    }

    _clearVerifyBarrier(roomId) {

        this._verifyConfirmedByRoom.delete(roomId);

        this._profilesRevealedByRoom.delete(roomId);

        this._allProfilesReadyByRoom.delete(roomId);

        this._verifyIconsAssignedByRoom.delete(roomId);

        this._continueToVerifyByRoom.delete(roomId);

        this._verifyBarrierCompletedByRoom.delete(roomId);

        this._secretMatrixByRoom.delete(roomId);

        this._secretMatrixRevisionByRoom.delete(roomId);

        this._secretMatrixAcceptedByRoom.delete(roomId);

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

        this._recoveryCredentials.invalidate(playerId);

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
     * owns room destroy after VERIFY_BARRIER_COMPLETED.
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
