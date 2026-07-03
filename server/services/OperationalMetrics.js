import { EVENT_TYPES } from "../events/EventTypes.js";

// C4.5 — Operational metric counter names. Kept here so tests and dashboards
// reference the same authoritative keys.
export const OPERATIONAL_COUNTERS = Object.freeze({
    GAMES_STARTED: "games.started",
    GAMES_COMPLETED: "games.completed",
    RECONNECTS: "reconnects",
    PAYMENTS_COMPLETED: "payments.completed",
    PAYMENTS_FAILED: "payments.failed",
    AUDITS_COMPLETED: "audits.completed",
    AUDITS_FAILED: "audits.failed",
    CLEANUPS: "cleanup.completed"
});

export const GAME_DURATION_METRIC = "game.duration";

/**
 * C4.5 — Operational metrics observer.
 *
 * A read-only EventBus subscriber that translates existing authoritative
 * lifecycle events into production counters and the average game duration. It
 * introduces no gameplay behavior, mutates no engine state, and can be removed
 * without affecting the game — it only observes.
 *
 * "Game started" is anchored on PHYSICS_STARTED (the authoritative start of
 * gameplay) and "game completed" on CLEANUP_COMPLETED (the final lifecycle
 * event), so duration reflects the full authoritative gameplay-to-teardown span.
 */
export class OperationalMetrics {

    constructor({ logger, eventBus, metricsService, devMode = false }) {

        this._logger = logger;

        this._eventBus = eventBus;

        this._metricsService = metricsService;

        this._devMode = devMode;

        this._handlers = [];

        this._startTimes = new Map();

        this._initialized = false;

    }

    initialize() {

        this._subscribe(EVENT_TYPES.PHYSICS_STARTED, (payload) => {

            const gameId = payload?.gameId;

            if (gameId) {

                this._startTimes.set(gameId, Date.now());

            }

            this._metricsService.increment(OPERATIONAL_COUNTERS.GAMES_STARTED);

        });

        this._subscribe(EVENT_TYPES.PLAYER_RECOVERED, () => {

            this._metricsService.increment(OPERATIONAL_COUNTERS.RECONNECTS);

        });

        this._subscribe(EVENT_TYPES.PAYMENT_COMPLETED, () => {

            this._metricsService.increment(OPERATIONAL_COUNTERS.PAYMENTS_COMPLETED);

        });

        this._subscribe(EVENT_TYPES.PAYMENT_FAILED, () => {

            this._metricsService.increment(OPERATIONAL_COUNTERS.PAYMENTS_FAILED);

        });

        this._subscribe(EVENT_TYPES.AUDIT_READY, () => {

            this._metricsService.increment(OPERATIONAL_COUNTERS.AUDITS_COMPLETED);

        });

        this._subscribe(EVENT_TYPES.AUDIT_FAILED, () => {

            this._metricsService.increment(OPERATIONAL_COUNTERS.AUDITS_FAILED);

        });

        this._subscribe(EVENT_TYPES.CLEANUP_COMPLETED, (payload) => {

            const gameId = payload?.gameId;

            this._metricsService.increment(OPERATIONAL_COUNTERS.GAMES_COMPLETED);

            this._metricsService.increment(OPERATIONAL_COUNTERS.CLEANUPS);

            if (gameId && this._startTimes.has(gameId)) {

                const durationMs = Date.now() - this._startTimes.get(gameId);

                this._startTimes.delete(gameId);

                this._metricsService.record(GAME_DURATION_METRIC, durationMs);

            }

        });

        this._subscribe(EVENT_TYPES.SERVER_SHUTDOWN, () => {

            this._startTimes.clear();

        });

        this._initialized = true;

    }

    shutdown() {

        for (const subscription of this._handlers) {

            this._eventBus.unsubscribe(subscription.event, subscription.handler);

        }

        this._handlers = [];

        this._startTimes.clear();

        this._initialized = false;

    }

    _subscribe(event, handler) {

        const wrapped = (envelope) => handler(envelope.payload);

        this._eventBus.subscribe(event, wrapped);

        this._handlers.push({ event, handler: wrapped });

    }

}
