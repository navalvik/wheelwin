import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";

const DEFAULT_RESULT_SESSION_DURATION_MS = 5 * 60 * 1000;

/**
 * R6.5 — Result Session wall-clock after OPEN_PAGE6.
 *
 * Owns the five-minute linger on Page6. Manual FINISH and automatic expiry
 * share the same RoomLobbyBridge finish path; this class only schedules and
 * emits RESULT_SESSION_EXPIRED. Does not destroy rooms or touch gameplay.
 */
export class ResultSessionLifecycle {

    constructor({
        logger,
        eventBus,
        roomConfig = null,
        devMode = false
    }) {

        this._logger = logger;

        this._eventBus = eventBus;

        this._durationMs = Number.isFinite(roomConfig?.resultSessionDurationMs)
            && roomConfig.resultSessionDurationMs > 0
            ? roomConfig.resultSessionDurationMs
            : DEFAULT_RESULT_SESSION_DURATION_MS;

        this._devMode = devMode;

        this._sessions = new Map();

        this._expiryTimers = new Map();

        this._handlers = [];

        this._initialized = false;

    }

    initialize() {

        this._subscribe(
            EVENT_TYPES.ROOM_DESTROYED,
            (envelope) => {

                this.cancel(envelope.payload?.roomId);

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
     * Start (or restart) the result linger for a room that just opened Page6.
     */
    start(roomId, { gameId = null } = {}) {

        this._assertInitialized();

        if (!roomId) {

            return null;

        }

        this.cancel(roomId);

        const startedAt = Date.now();

        const session = Object.freeze({
            roomId,
            gameId: gameId ?? null,
            startedAt,
            expiresAt: startedAt + this._durationMs,
            durationMs: this._durationMs
        });

        this._sessions.set(roomId, session);

        this._scheduleExpiry(session);

        this._log(
            `STARTED | roomId=${roomId} | gameId=${gameId ?? "—"} | durationMs=${this._durationMs}`
        );

        return session;

    }

    cancel(roomId) {

        if (!roomId) {

            return;

        }

        this._clearExpiry(roomId);

        this._sessions.delete(roomId);

    }

    isActive(roomId) {

        return this._sessions.has(roomId);

    }

    getSession(roomId) {

        return this._sessions.get(roomId) ?? null;

    }

    /**
     * R6.0C — Read-only active result-session count for projections.
     */
    getActiveSessionCount() {

        return this._sessions.size;

    }

    getDurationMs() {

        return this._durationMs;

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

        this._sessions.delete(roomId);

        this._log(`EXPIRED | roomId=${roomId} | gameId=${session.gameId ?? "—"}`);

        this._emit(EVENT_TYPES.RESULT_SESSION_EXPIRED, {
            roomId,
            gameId: session.gameId,
            reason: "result_session_expired",
            startedAt: session.startedAt,
            expiresAt: session.expiresAt,
            timestamp: Date.now()
        });

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

        this._sessions.clear();

    }

    _subscribe(event, handler) {

        this._eventBus.subscribe(event, handler);

        this._handlers.push({ event, handler });

    }

    _emit(type, payload) {

        this._eventBus.emit({
            source: EVENT_SOURCES.RESULT_SESSION_LIFECYCLE,
            type,
            payload
        });

    }

    _assertInitialized() {

        if (!this._initialized) {

            throw new Error("ResultSessionLifecycle is not initialized");

        }

    }

    _log(message) {

        if (this._devMode) {

            this._logger.info(`[ResultSessionLifecycle] ${message}`);

        }

    }

}
