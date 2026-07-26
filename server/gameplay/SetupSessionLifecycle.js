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

        if (this._sessions.has(roomId)) {

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

        this._sessions.set(roomId, session);

        this._scheduleExpiry(session);

        this._emit(EVENT_TYPES.SETUP_SESSION_STARTED, session.toSnapshot());

        this._log(`STARTED | roomId=${roomId} | setupSessionId=${session.setupSessionId}`);

        return session;

    }

    getSession(roomId) {

        return this._sessions.get(roomId) ?? null;

    }

    isActive(roomId) {

        return this._sessions.get(roomId)?.isActive() === true;

    }

    /**
     * R6.1 — True while the Setup Session wall-clock window still owns the
     * room (ACTIVE lobby or COMPLETED prep). Soft disconnect / reclaim apply.
     */
    isRecoverable(roomId) {

        const session = this._sessions.get(roomId);

        if (!session) {

            return false;

        }

        return session.state === SETUP_SESSION_STATUS.ACTIVE
            || session.state === SETUP_SESSION_STATUS.COMPLETED;

    }

    buildSyncPayload(roomId, now = Date.now()) {

        const session = this._sessions.get(roomId);

        if (!session) {

            return null;

        }

        // ACTIVE waiting lobby + COMPLETED prep window both expose expiresAt so
        // InfoBar can derive remaining time without owning a local timer.
        if (session.state !== SETUP_SESSION_STATUS.ACTIVE
            && session.state !== SETUP_SESSION_STATUS.COMPLETED) {

            return null;

        }

        return session.toSnapshot(now);

    }

    /**
     * Abort an active Setup Session without emitting EXPIRED (room teardown).
     */
    abortForRoom(roomId) {

        const session = this._sessions.get(roomId);

        if (!session) {

            return false;

        }

        this._clearExpiry(roomId);

        if (session.isActive()) {

            session.abort();

            this._log(`ABORTED | roomId=${roomId}`);

        }

        this._sessions.delete(roomId);

        return true;

    }

    _handleRoomFull(roomId) {

        if (!roomId) {

            return;

        }

        const session = this._sessions.get(roomId);

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

        const session = this._sessions.get(roomId);

        if (!session) {

            return;

        }

        // ACTIVE lobby timeout and COMPLETED prep-window timeout both expire.
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

        this._sessions.delete(roomId);

        // RoomManager decides destruction. Bridge may already have closed the
        // room while handling EXPIRED (sync); destroy only if still present.
        if (this._roomManager.getRoom(roomId)) {

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

        this._sessions.clear();

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
