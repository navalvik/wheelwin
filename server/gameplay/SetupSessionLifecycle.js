import { registerRoomDestroyContext } from "../diagnostics/RoomDestroyForensics.js";
import {
    getSetupStorageStageContext,
    logSetupStorageClear,
    logSetupStorageDelete,
    logSetupStorageMiss,
    logSetupStorageMutation
} from "../diagnostics/SetupSessionStorageForensics.js";
import { logPaymentTransitionFailure } from "../diagnostics/PaymentTransitionForensics.js";
import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { SetupSession } from "../models/SetupSession.js";
import { SETUP_SESSION_STATUS } from "../models/SetupSessionStatus.js";

const DEFAULT_SETUP_DURATION_MS = 10 * 60 * 1000;

/**
 * C5.6C — Setup Session lifecycle coordinator.
 *
 * Owns the 1:1 Setup Session registry and Setup Timer expiry. Creates sessions
 * for rooms, advances preparation on ROOM_FULL, signals GameManager via
 * SETUP_SESSION_COMPLETED, and emits authoritative STARTED / SYNC / EXPIRED.
 *
 * Not a manager. Does not create games, physics, or recovery snapshots.
 */
export class SetupSessionLifecycle {

    constructor({
        logger,
        eventBus,
        roomManager,
        roomConfig = null,
        devMode = false
    }) {

        this._logger = logger;

        this._eventBus = eventBus;

        this._roomManager = roomManager;

        this._durationMs = Number.isFinite(roomConfig?.setupDurationMs)
            && roomConfig.setupDurationMs > 0
            ? roomConfig.setupDurationMs
            : DEFAULT_SETUP_DURATION_MS;

        this._devMode = devMode;

        this._sessions = new Map();

        this._expiryTimers = new Map();

        this._handlers = [];

        this._initialized = false;

        /** @type {{ isAcceptingNewWork: () => boolean } | null} R7.0B */
        this._lifecycleGate = null;

    }

    /**
     * R7.0B — Drain gate for new setup sessions.
     */
    attachLifecycleGate(lifecycleGate) {

        this._lifecycleGate = lifecycleGate;

    }

    _storageStageContext(roomId) {

        const session = this._sessions.get(roomId);

        return {
            currentStage: session?.state ?? null,
            ...getSetupStorageStageContext(roomId)
        };

    }

    _isSessionRecoverable(session) {

        return Boolean(session)
            && (session.state === SETUP_SESSION_STATUS.ACTIVE
                || session.state === SETUP_SESSION_STATUS.COMPLETED
                || session.state === SETUP_SESSION_STATUS.ARCHIVED);

    }

    _sessionGet(roomId, caller, { logMiss = false } = {}) {

        const mapSizeBefore = this._sessions.size;
        const session = this._sessions.get(roomId) ?? null;
        const stage = this._storageStageContext(roomId);

        logSetupStorageMutation({
            operation: "GET",
            roomId,
            currentState: session?.state ?? null,
            recoverable: this._isSessionRecoverable(session),
            caller,
            mapSizeBefore,
            mapSizeAfter: this._sessions.size,
            currentStage: stage.currentStage,
            paymentStage: stage.PaymentStage,
            deployStage: stage.DeployStage
        });

        if (!session && logMiss) {

            logSetupStorageMiss({
                roomId,
                caller,
                currentStage: stage.currentStage,
                paymentStage: stage.PaymentStage,
                deployStage: stage.DeployStage,
                mapSize: this._sessions.size,
                existingKeys: [...this._sessions.keys()]
            });

        }

        return session;

    }

    _sessionHas(roomId, caller) {

        const mapSizeBefore = this._sessions.size;
        const exists = this._sessions.has(roomId);
        const session = exists ? this._sessions.get(roomId) : null;
        const stage = this._storageStageContext(roomId);

        logSetupStorageMutation({
            operation: "HAS",
            roomId,
            currentState: session?.state ?? null,
            recoverable: this._isSessionRecoverable(session),
            caller,
            mapSizeBefore,
            mapSizeAfter: this._sessions.size,
            currentStage: stage.currentStage,
            paymentStage: stage.PaymentStage,
            deployStage: stage.DeployStage
        });

        return exists;

    }

    _sessionSet(roomId, session, caller, reason) {

        const mapSizeBefore = this._sessions.size;
        const stage = this._storageStageContext(roomId);

        this._sessions.set(roomId, session);

        logSetupStorageMutation({
            operation: "SET",
            roomId,
            currentState: session?.state ?? null,
            recoverable: this._isSessionRecoverable(session),
            caller,
            reason,
            mapSizeBefore,
            mapSizeAfter: this._sessions.size,
            currentStage: stage.currentStage,
            paymentStage: stage.PaymentStage,
            deployStage: stage.DeployStage
        });

    }

    _sessionDelete(roomId, caller, reason) {

        const mapSizeBefore = this._sessions.size;
        const session = this._sessions.get(roomId) ?? null;
        const stage = this._storageStageContext(roomId);
        const recoverable = this._isSessionRecoverable(session);

        this._sessions.delete(roomId);

        logSetupStorageDelete({
            roomId,
            previousState: session?.state ?? null,
            recoverable,
            caller,
            reason,
            currentStage: stage.currentStage,
            deployStage: stage.DeployStage,
            mapSizeBefore,
            mapSizeAfter: this._sessions.size
        });

        logSetupStorageMutation({
            operation: "DELETE",
            roomId,
            currentState: session?.state ?? null,
            recoverable,
            caller,
            reason,
            mapSizeBefore,
            mapSizeAfter: this._sessions.size,
            currentStage: stage.currentStage,
            paymentStage: stage.PaymentStage,
            deployStage: stage.DeployStage
        });

    }

    _sessionClear(caller, reason) {

        const previousMapSize = this._sessions.size;

        this._sessions.clear();

        logSetupStorageClear({
            caller,
            reason,
            currentStage: "shutdown",
            deployStage: null,
            previousMapSize
        });

        logSetupStorageMutation({
            operation: "CLEAR",
            roomId: null,
            caller,
            reason,
            mapSizeBefore: previousMapSize,
            mapSizeAfter: this._sessions.size
        });

    }

    initialize() {

        this._subscribe(
            EVENT_TYPES.ROOM_FULL,
            (envelope) => {

                this._handleRoomFull(envelope.payload?.roomId);

            }
        );

        this._subscribe(
            EVENT_TYPES.ROOM_DESTROYED,
            (envelope) => {

                this._handleRoomDestroyed(envelope.payload?.roomId);

            }
        );

        this._subscribe(
            EVENT_TYPES.SERVER_SHUTDOWN,
            () => {

                this._reset();

            }
        );

        this._initialized = true;

    }

    shutdown() {

        this._reset();

        for (const subscription of this._handlers) {

            this._eventBus.unsubscribe(
                subscription.event,
                subscription.handler
            );

        }

        this._handlers = [];

        this._initialized = false;

    }

    /**
     * Atomic with RoomManager.createRoom — called before ROOM_CREATED returns.
     */
    createForRoom(room) {

        this._assertInitialized();

        if (this._lifecycleGate
            && this._lifecycleGate.isAcceptingNewWork() !== true) {

            this._logger.warn(
                "Setup Session creation rejected: server is draining"
            );

            return null;

        }

        const roomId = room?.roomId;

        if (!roomId) {

            this._logger.error(
                "Setup Session creation failed: roomId is required"
            );

            return null;

        }

        if (this._sessionHas(roomId, "SetupSessionLifecycle.createForRoom")) {

            this._logger.error(
                `Setup Session creation failed: already exists (${roomId})`
            );

            return null;

        }

        const startedAt = Date.now();

        const session = new SetupSession({
            roomId,
            startedAt,
            expiresAt: startedAt + this._durationMs
        });

        session.activate();

        this._sessionSet(roomId, session, "SetupSessionLifecycle.createForRoom", "setup_created");

        this._scheduleExpiry(session);

        this._emit(EVENT_TYPES.SETUP_SESSION_STARTED, session.toSnapshot());

        this._log(`STARTED | roomId=${roomId} | setupSessionId=${session.setupSessionId}`);

        return session;

    }

    getSession(roomId) {

        return this._sessionGet(roomId, "SetupSessionLifecycle.getSession") ?? null;

    }

    isActive(roomId) {

        return this._sessionGet(roomId, "SetupSessionLifecycle.isActive")?.isActive() === true;

    }

    /**
     * R6.1 / R6.38 — Soft disconnect / reclaim while Setup Session exists:
     * ACTIVE lobby, COMPLETED prep, or ARCHIVED (payment owns destroy; SYNC
     * still exposes immutable expiresAt for InfoBar).
     */
    isRecoverable(roomId) {

        const session = this._sessionGet(roomId, "SetupSessionLifecycle.isRecoverable");

        const recoverable = this._isSessionRecoverable(session);

        console.log("======================================================");
        console.log("SETUP PROTECTION CHECK");
        console.log({
            Timestamp: new Date().toISOString(),
            RoomId: roomId ?? null,
            CurrentState: session?.state ?? null,
            Recoverable: recoverable
        });
        console.trace("SetupSessionLifecycle.isRecoverable trace");
        console.log("======================================================");

        return recoverable;

    }

    buildSyncPayload(roomId, now = Date.now()) {

        const session = this._sessionGet(
            roomId,
            "SetupSessionLifecycle.buildSyncPayload",
            { logMiss: true }
        );

        if (!session) {

            return null;

        }

        // ACTIVE / COMPLETED / ARCHIVED expose expiresAt so InfoBar can derive
        // remaining time without owning a local timer (RC-FIX-006 + R6.38).
        if (session.state !== SETUP_SESSION_STATUS.ACTIVE
            && session.state !== SETUP_SESSION_STATUS.COMPLETED
            && session.state !== SETUP_SESSION_STATUS.ARCHIVED) {

            return null;

        }

        return session.toSnapshot(now);

    }

    /**
     * R6.38 — Ownership transfer at PAYMENT_STAGE_READY.
     * Destroys Setup timer permanently; archives session (no destroy authority).
     * Payment lifecycle becomes the sole room-lifetime owner afterwards.
     *
     * @returns {object | null} archived sync snapshot, or null if no handoff
     */
    archiveForPayment(roomId) {

        this._assertInitialized();

        if (!roomId) {

            console.log("======================================================");
            console.log("ARCHIVE FOR PAYMENT");
            console.log({
                Timestamp: new Date().toISOString(),
                RoomId: null,
                Result: "null_roomId",
                Caller: "SetupSessionLifecycle.archiveForPayment"
            });
            console.trace();
            console.log("======================================================");

            logPaymentTransitionFailure({
                roomId: null,
                reason: "null_roomId",
                currentSetupState: null,
                recoverable: false,
                caller: "SetupSessionLifecycle.archiveForPayment",
                willContinueTransition: true
            });

            this._logger.decisionTrace({
                stage: "ARCHIVE_SETUP",
                decision: "FAIL",
                reason: "null_roomId",
                caller: "SetupSessionLifecycle.archiveForPayment",
                nextAction: "PAYMENT_STAGE_READY (caller continues)",
                roomId: null
            });

            return null;

        }

        const session = this._sessionGet(
            roomId,
            "SetupSessionLifecycle.archiveForPayment",
            { logMiss: true }
        );

        if (!session) {

            console.log("======================================================");
            console.log("ARCHIVE FOR PAYMENT");
            console.log({
                Timestamp: new Date().toISOString(),
                RoomId: roomId,
                Result: "null_session",
                Caller: "SetupSessionLifecycle.archiveForPayment"
            });
            console.trace();
            console.log("======================================================");

            logPaymentTransitionFailure({
                roomId,
                reason: "null_session",
                currentSetupState: null,
                recoverable: false,
                caller: "SetupSessionLifecycle.archiveForPayment",
                willContinueTransition: true
            });

            this._logger.decisionTrace({
                stage: "ARCHIVE_SETUP",
                decision: "FAIL",
                reason: "null_session",
                caller: "SetupSessionLifecycle.archiveForPayment",
                nextAction: "PAYMENT_STAGE_READY (caller continues)",
                roomId
            });

            return null;

        }

        if (session.state === SETUP_SESSION_STATUS.ARCHIVED) {

            console.log("======================================================");
            console.log("ARCHIVE FOR PAYMENT");
            console.log({
                Timestamp: new Date().toISOString(),
                RoomId: roomId,
                SetupSessionId: session.setupSessionId,
                PreState: session.state,
                Result: "already_archived"
            });
            console.trace();
            console.log("======================================================");

            this._clearExpiry(roomId);

            this._logger.decisionTrace({
                stage: "ARCHIVE_SETUP",
                decision: "ARCHIVED",
                reason: "Setup already archived (idempotent).",
                caller: "SetupSessionLifecycle.archiveForPayment",
                nextAction: "PAYMENT_STAGE_READY",
                roomId
            });

            return session.toSnapshot();

        }

        if (
            session.state !== SETUP_SESSION_STATUS.COMPLETED
            && session.state !== SETUP_SESSION_STATUS.ACTIVE
        ) {

            console.log("======================================================");
            console.log("ARCHIVE FOR PAYMENT");
            console.log({
                Timestamp: new Date().toISOString(),
                RoomId: roomId,
                SetupSessionId: session.setupSessionId,
                PreState: session.state,
                Result: "state_not_archiveable"
            });
            console.trace();
            console.log("======================================================");

            logPaymentTransitionFailure({
                roomId,
                reason: "state_not_archiveable",
                currentSetupState: session.state,
                recoverable: this._isSessionRecoverable(session),
                caller: "SetupSessionLifecycle.archiveForPayment",
                willContinueTransition: true
            });

            this._logger.decisionTrace({
                stage: "ARCHIVE_SETUP",
                decision: "FAIL",
                reason: `state_not_archiveable (${session.state})`,
                caller: "SetupSessionLifecycle.archiveForPayment",
                nextAction: "PAYMENT_STAGE_READY (caller continues)",
                roomId
            });

            return null;

        }

        console.log("======================================================");
        console.log("ARCHIVE FOR PAYMENT");
        console.log({
            Timestamp: new Date().toISOString(),
            RoomId: roomId,
            SetupSessionId: session.setupSessionId,
            PreState: session.state,
            Result: "archiving_now"
        });
        console.trace();
        console.log("======================================================");

        this._clearExpiry(roomId);

        session.archive();

        const snapshot = session.toSnapshot();

        this._log(
            `ARCHIVED | roomId=${roomId} | setupSessionId=${session.setupSessionId}`
        );

        this._logger.decisionTrace({
            stage: "ARCHIVE_SETUP",
            decision: "ARCHIVED",
            reason: "Setup successfully archived.",
            caller: "SetupSessionLifecycle.archiveForPayment",
            nextAction: "PAYMENT_STAGE_READY",
            roomId
        });

        return snapshot;

    }

    /**
     * Abort an active Setup Session without emitting EXPIRED (room teardown).
     */
    abortForRoom(roomId) {

        const session = this._sessionGet(
            roomId,
            "SetupSessionLifecycle.abortForRoom",
            { logMiss: true }
        );

        if (!session) {

            return false;

        }

        this._clearExpiry(roomId);

        if (session.isActive()) {

            session.abort();

            this._log(`ABORTED | roomId=${roomId}`);

        }

        console.log("======================================================");
        console.log("SETUP SESSION DESTROYED");
        console.log({
            Timestamp: new Date().toISOString(),
            RoomId: roomId,
            StateBeforeRemoval: session.state,
            Reason: "abort_for_room",
            Caller: "SetupSessionLifecycle.abortForRoom"
        });
        console.trace();
        console.log("======================================================");

        this._sessionDelete(roomId, "SetupSessionLifecycle.abortForRoom", "abort_for_room");

        return true;

    }

    _handleRoomFull(roomId) {

        if (!roomId) {

            return;

        }

        const session = this._sessionGet(roomId, "SetupSessionLifecycle._handleRoomFull");

        if (!session || !session.isActive()) {

            return;

        }

        try {

            session.markRoomFull();

            // Preparation gates: room capacity is the authoritative signal that
            // verification roster and payment preparation may proceed for this
            // stage. Future stages may require explicit client confirmations;
            // completion still occurs only through tryComplete().
            session.markVerificationReady();

            session.markPaymentPrepReady();

            this._tryComplete(session);

        } catch (error) {

            this._logger.error(
                `Setup Session ROOM_FULL handling failed | roomId=${roomId} | reason=${error.message}`
            );

        }

    }

    _tryComplete(session) {

        if (!session.isCompletionReady()) {

            return false;

        }

        // Do not clear the wall-clock expiry timer — COMPLETED prep pages still
        // count down to expiresAt, and SETUP_SESSION_EXPIRED must fire then.
        session.complete();

        const snapshot = session.toSnapshot();

        this._log(
            `COMPLETED | roomId=${session.roomId} | setupSessionId=${session.setupSessionId}`
        );

        this._emit(EVENT_TYPES.SETUP_SESSION_COMPLETED, {
            roomId: session.roomId,
            setupSessionId: session.setupSessionId,
            snapshot
        });

        // Keep COMPLETED session until ROOM_DESTROYED / EXPIRED so prep pages
        // can still SYNC expiresAt for the Setup Timer (InfoBar).

        return true;

    }

    _handleRoomDestroyed(roomId) {

        if (!roomId) {

            return;

        }

        this.abortForRoom(roomId);

    }

    _scheduleExpiry(session) {

        const delay = Math.max(0, session.expiresAt - Date.now());

        const timerId = setTimeout(() => {

            this._onExpiry(session.roomId);

        }, delay);

        this._expiryTimers.set(session.roomId, timerId);

    }

    _onExpiry(roomId) {

        this._expiryTimers.delete(roomId);

        const session = this._sessionGet(
            roomId,
            "SetupSessionLifecycle._onExpiry",
            { logMiss: true }
        );

        if (!session) {

            return;

        }

        // R6.38 — ARCHIVED never expires / never destroys the room.
        // ACTIVE lobby + COMPLETED prep (pre-PAYMENT) may still expire.
        if (session.state !== SETUP_SESSION_STATUS.ACTIVE
            && session.state !== SETUP_SESSION_STATUS.COMPLETED) {

            return;

        }

        let snapshot;

        if (session.isActive()) {

            session.expire();

            snapshot = session.toSnapshot();

        } else {

            // COMPLETED sessions are immutable — emit EXPIRED without mutate.
            snapshot = Object.freeze({
                ...session.toSnapshot(),
                state: SETUP_SESSION_STATUS.EXPIRED,
                remainingTime: 0
            });

        }

        this._log(
            `EXPIRED | roomId=${roomId} | setupSessionId=${session.setupSessionId}`
        );

        this._emit(EVENT_TYPES.SETUP_SESSION_EXPIRED, snapshot);

        console.log("======================================================");
        console.log("SETUP SESSION DESTROYED");
        console.log({
            Timestamp: new Date().toISOString(),
            RoomId: roomId,
            StateBeforeRemoval: session.state,
            Reason: "setup_expired",
            Caller: "SetupSessionLifecycle._onExpiry"
        });
        console.trace();
        console.log("======================================================");

        this._sessionDelete(roomId, "SetupSessionLifecycle._onExpiry", "setup_expired");

        // RoomManager decides destruction. Bridge may already have closed the
        // room while handling EXPIRED (sync); destroy only if still present.
        if (this._roomManager.getRoom(roomId)) {

            registerRoomDestroyContext(roomId, {
                reason: "setup_expired",
                caller: "SetupSessionLifecycle._onExpiry",
                triggerEvent: EVENT_TYPES.SETUP_SESSION_EXPIRED,
                currentGameStage: "SETUP",
                setupSession: snapshot?.state ?? SETUP_SESSION_STATUS.EXPIRED
            });

            this._roomManager.destroyRoom(roomId);

        }

    }

    _clearExpiry(roomId) {

        const timerId = this._expiryTimers.get(roomId);

        if (timerId) {

            clearTimeout(timerId);

            this._expiryTimers.delete(roomId);

        }

    }

    _reset() {

        for (const roomId of [...this._expiryTimers.keys()]) {

            this._clearExpiry(roomId);

        }

        for (const session of this._sessions.values()) {

            if (session.isActive()) {

                session.abort();

            }

        }

        console.log("======================================================");
        console.log("SETUP SESSION DESTROYED");
        console.log({
            Timestamp: new Date().toISOString(),
            Reason: "reset_clear",
            SessionsClearedCount: this._sessions.size ?? null
        });
        console.trace("SetupSessionLifecycle._reset trace");
        console.log("======================================================");

        this._sessionClear("SetupSessionLifecycle._reset", "reset_clear");

    }

    _subscribe(event, handler) {

        this._eventBus.subscribe(event, handler);

        this._handlers.push({ event, handler });

    }

    _emit(type, payload) {

        this._eventBus.emit({
            source: EVENT_SOURCES.SETUP_SESSION_LIFECYCLE,
            type,
            payload
        });

    }

    _assertInitialized() {

        if (!this._initialized) {

            throw new Error("SetupSessionLifecycle is not initialized");

        }

    }

    _log(message) {

        if (this._devMode) {

            this._logger.info(`[SetupSessionLifecycle] ${message}`);

        }

    }

    getDebugSnapshot() {

        return {
            activeCount: this._sessions.size,
            sessions: [...this._sessions.values()].map((session) => ({
                roomId: session.roomId,
                setupSessionId: session.setupSessionId,
                state: session.state,
                remainingTime: session.remainingTime()
            }))
        };

    }

    /**
     * R7.0B — Active setup session count for drain wait.
     */
    getActiveSessionCount() {

        return this._sessions.size;

    }

}
