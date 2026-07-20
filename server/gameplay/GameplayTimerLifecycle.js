import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { GAME_STATES } from "../engines/gameState/GameStates.js";
import { GameplayTimer } from "../models/GameplayTimer.js";
import {
    DEFAULT_GAMEPLAY_DURATION_MS,
    DEFAULT_GAMEPLAY_WARNING_MS
} from "../config/gameplayTimer.js";

/**
 * R1.3C — Gameplay Timer lifecycle (Timer 2).
 *
 * Owns the Page5 wall clock only. Does not own phases, physics, winners,
 * or cleanup. One timer per gameId.
 *
 * R1.3G — WARNING is derived from authoritative remainingTime() (expiresAt
 * anchor), not from blind setTimeout success. Scheduled wake-ups only prompt
 * evaluation; expiry and sync paths re-check before marking expired.
 */
export class GameplayTimerLifecycle {

    constructor({
        logger,
        eventBus,
        gameplayTimerConfig = null,
        devMode = false
    }) {

        this._logger = logger;

        this._eventBus = eventBus;

        this._durationMs = Number.isFinite(gameplayTimerConfig?.gameplayDurationMs)
            && gameplayTimerConfig.gameplayDurationMs > 0
            ? gameplayTimerConfig.gameplayDurationMs
            : DEFAULT_GAMEPLAY_DURATION_MS;

        this._warningMs = Number.isFinite(gameplayTimerConfig?.gameplayWarningMs)
            && gameplayTimerConfig.gameplayWarningMs >= 0
            ? gameplayTimerConfig.gameplayWarningMs
            : DEFAULT_GAMEPLAY_WARNING_MS;

        this._devMode = devMode;

        this._timers = new Map();

        this._warningHandles = new Map();

        this._expiryHandles = new Map();

        this._handlers = [];

        this._initialized = false;

    }

    initialize() {

        this._subscribe(
            EVENT_TYPES.GAME_INITIALIZED,
            (envelope) => {

                this.create(
                    envelope.payload?.gameId,
                    { roomId: envelope.payload?.roomId ?? null }
                );

            }
        );

        this._subscribe(
            EVENT_TYPES.GAME_STATE_CHANGED,
            (envelope) => {

                this._handleGameStateChanged(envelope.payload);

            }
        );

        this._subscribe(
            EVENT_TYPES.GAME_DESTROYED,
            (envelope) => {

                this.destroy(envelope.payload?.gameId);

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

    create(gameId, { roomId = null, now = Date.now() } = {}) {

        this._assertInitialized();

        if (!gameId) {

            this._logger.error(
                "Gameplay Timer creation failed: gameId is required"
            );

            return null;

        }

        if (this._timers.has(gameId)) {

            this._evaluateWarning(gameId, now);

            return this._timers.get(gameId);

        }

        const timer = new GameplayTimer({
            gameId,
            roomId,
            startedAt: now,
            expiresAt: now + this._durationMs,
            durationMs: this._durationMs
        });

        this._timers.set(gameId, timer);

        this._scheduleWarningEvaluation(timer, now);

        this._scheduleExpiry(timer, now);

        this._evaluateWarning(gameId, now);

        const snapshot = timer.toSnapshot(now);

        this._emit(EVENT_TYPES.GAMEPLAY_TIMER_STARTED, snapshot);

        this._emit(EVENT_TYPES.GAMEPLAY_TIMER_SYNC, snapshot);

        this._log(
            `STARTED | gameId=${gameId} | durationMs=${this._durationMs}`
        );

        return timer;

    }

    getTimer(gameId) {

        return this._timers.get(gameId) ?? null;

    }

    hasTimer(gameId) {

        return this._timers.has(gameId);

    }

    buildSyncPayload(gameId, now = Date.now()) {

        const timer = this._timers.get(gameId);

        if (!timer || timer.expired) {

            return null;

        }

        this._evaluateWarning(gameId, now);

        return timer.toSnapshot(now);

    }

    destroy(gameId) {

        if (!gameId || !this._timers.has(gameId)) {

            return false;

        }

        this._clearSchedules(gameId);

        this._timers.delete(gameId);

        this._log(`DESTROYED | gameId=${gameId}`);

        return true;

    }

    _handleGameStateChanged(payload) {

        const gameId = payload?.gameId;

        const state = payload?.currentState ?? payload?.state;

        // Natural finish — cancel wall clock so late expiry is a no-op.
        if (gameId && state === GAME_STATES.RESULT) {

            this.destroy(gameId);

        }

    }

    /**
     * Schedule a one-shot wake-up near the warning threshold. The callback only
     * prompts _evaluateWarning(); emission requires remainingTime() <= warningMs.
     */
    _scheduleWarningEvaluation(timer, now = Date.now()) {

        const remaining = timer.remainingTime(now);

        const delay = Math.max(0, remaining - this._warningMs);

        const handle = setTimeout(() => {

            this._warningHandles.delete(timer.gameId);

            this._evaluateWarning(timer.gameId, Date.now());

        }, delay);

        if (typeof handle.unref === "function") {

            handle.unref();

        }

        this._warningHandles.set(timer.gameId, handle);

    }

    _scheduleExpiry(timer, now = Date.now()) {

        const delay = Math.max(0, timer.remainingTime(now));

        const handle = setTimeout(() => {

            this._expiryHandles.delete(timer.gameId);

            this._onExpiry(timer.gameId);

        }, delay);

        if (typeof handle.unref === "function") {

            handle.unref();

        }

        this._expiryHandles.set(timer.gameId, handle);

    }

    /**
     * Authoritative warning gate — single source of truth is remainingTime().
     */
    _evaluateWarning(gameId, now = Date.now()) {

        const timer = this._timers.get(gameId);

        if (!timer || timer.expired || timer.warningEmitted) {

            return false;

        }

        const remaining = timer.remainingTime(now);

        if (remaining > this._warningMs) {

            return false;

        }

        timer.markWarningEmitted();

        const snapshot = timer.toSnapshot(now);

        this._emit(EVENT_TYPES.GAMEPLAY_TIMER_WARNING, snapshot);

        this._log(`WARNING | gameId=${gameId} | remainingMs=${remaining}`);

        return true;

    }

    _onExpiry(gameId) {

        const timer = this._timers.get(gameId);

        if (!timer || timer.expired) {

            return;

        }

        const now = Date.now();

        // Last-chance warning before expiry — survives event-loop delay/races.
        this._evaluateWarning(gameId, now);

        this._clearSchedules(gameId);

        timer.markExpired();

        const snapshot = timer.toSnapshot(now);

        this._emit(EVENT_TYPES.GAMEPLAY_TIMER_EXPIRED, snapshot);

        this._log(`EXPIRED | gameId=${gameId}`);

        // Keep record briefly so SYNC/reconnect can still see expired=true
        // until destroy; activation consumes EXPIRED once.

    }

    _clearSchedules(gameId) {

        const warning = this._warningHandles.get(gameId);

        if (warning) {

            clearTimeout(warning);

            this._warningHandles.delete(gameId);

        }

        const expiry = this._expiryHandles.get(gameId);

        if (expiry) {

            clearTimeout(expiry);

            this._expiryHandles.delete(gameId);

        }

    }

    _reset() {

        for (const gameId of [...this._timers.keys()]) {

            this.destroy(gameId);

        }

    }

    _subscribe(event, handler) {

        this._eventBus.subscribe(event, handler);

        this._handlers.push({ event, handler });

    }

    _emit(type, payload) {

        this._eventBus.emit({
            source: EVENT_SOURCES.GAMEPLAY_TIMER_LIFECYCLE,
            type,
            payload
        });

    }

    _log(message) {

        if (!this._devMode) {

            this._logger.info(`[GameplayTimer] ${message}`);

            return;

        }

        this._logger.info(`[GameplayTimer] ${message}`);

    }

    _assertInitialized() {

        if (!this._initialized) {

            throw new Error("GameplayTimerLifecycle is not initialized");

        }

    }

}
