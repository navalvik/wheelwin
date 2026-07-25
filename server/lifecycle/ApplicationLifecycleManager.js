/**
 * R7.0B — Deterministic application lifecycle: RUNNING → DRAINING → STOPPED.
 *
 * Operational only — does not mutate gameplay engines. Callers supply an
 * activityProvider that reports in-flight work counts for the drain wait.
 */

import {
    APPLICATION_LIFECYCLE,
    DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_MS,
    DRAIN_POLL_INTERVAL_MS
} from "./ApplicationLifecycleStates.js";

export class ApplicationLifecycleManager {

    /**
     * @param {{
     *   logger: { info: Function, warn: Function, error: Function },
     *   metricsService?: { increment?: Function, record?: Function } | null,
     *   healthService?: { setLifecycleState?: Function, markShuttingDown?: Function } | null,
     *   gracefulShutdownTimeoutMs?: number,
     *   activityProvider?: (() => object) | null,
     *   pollIntervalMs?: number
     * }} options
     */
    constructor({
        logger,
        metricsService = null,
        healthService = null,
        loggingManager = null,
        gracefulShutdownTimeoutMs = DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_MS,
        activityProvider = null,
        pollIntervalMs = DRAIN_POLL_INTERVAL_MS
    }) {

        this._logger = logger;

        this._metricsService = metricsService;

        this._healthService = healthService;

        this._loggingManager = loggingManager;

        this._gracefulShutdownTimeoutMs = Number.isFinite(gracefulShutdownTimeoutMs)
            && gracefulShutdownTimeoutMs > 0
            ? gracefulShutdownTimeoutMs
            : DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_MS;

        this._activityProvider = typeof activityProvider === "function"
            ? activityProvider
            : null;

        this._pollIntervalMs = Number.isFinite(pollIntervalMs) && pollIntervalMs > 0
            ? pollIntervalMs
            : DRAIN_POLL_INTERVAL_MS;

        this._state = APPLICATION_LIFECYCLE.STARTING;

        this._drainStartedAt = null;

        this._drainReason = null;

        this._forcedShutdown = false;

        this._shutdownDurationMs = null;

        this._lastActivity = null;

        this._drainPromise = null;

    }

    getState() {

        return this._state;

    }

    isAcceptingNewWork() {

        return this._state === APPLICATION_LIFECYCLE.RUNNING;

    }

    isDraining() {

        return this._state === APPLICATION_LIFECYCLE.DRAINING;

    }

    isStopped() {

        return this._state === APPLICATION_LIFECYCLE.STOPPED;

    }

    wasForcedShutdown() {

        return this._forcedShutdown === true;

    }

    getGracefulShutdownTimeoutMs() {

        return this._gracefulShutdownTimeoutMs;

    }

    /**
     * Transition STARTING → RUNNING after listen succeeds.
     */
    markRunning() {

        if (this._state !== APPLICATION_LIFECYCLE.STARTING) {

            return;

        }

        this._transition(APPLICATION_LIFECYCLE.RUNNING, "startup_complete");

    }

    /**
     * Enter DRAINING. Idempotent — concurrent callers share one drain wait.
     *
     * @param {{ reason?: string }} [options]
     * @returns {Promise<{
     *   forced: boolean,
     *   durationMs: number,
     *   remaining: object,
     *   reason: string
     * }>}
     */
    beginDrain({ reason = "shutdown" } = {}) {

        if (this._state === APPLICATION_LIFECYCLE.STOPPED) {

            return Promise.resolve({
                forced: this._forcedShutdown,
                durationMs: this._shutdownDurationMs ?? 0,
                remaining: this._lastActivity ?? this._emptyActivity(),
                reason: this._drainReason ?? reason
            });

        }

        if (this._drainPromise) {

            return this._drainPromise;

        }

        if (this._state === APPLICATION_LIFECYCLE.RUNNING
            || this._state === APPLICATION_LIFECYCLE.STARTING) {

            this._drainReason = reason;

            this._drainStartedAt = Date.now();

            this._metricsService?.increment?.("shutdownStarted");

            this._healthService?.markShuttingDown?.();

            this._transition(APPLICATION_LIFECYCLE.DRAINING, reason);

            this._logger.info(
                `Drain mode active | timeoutMs=${this._gracefulShutdownTimeoutMs} | reason=${reason}`
            );

        }

        this._drainPromise = this._waitForDrainCompletion();

        return this._drainPromise;

    }

    /**
     * Final STOPPED marker after resource teardown.
     */
    markStopped({ forced = false } = {}) {

        if (this._state === APPLICATION_LIFECYCLE.STOPPED) {

            return;

        }

        if (forced) {

            this._forcedShutdown = true;

        }

        const durationMs = this._drainStartedAt != null
            ? Math.max(0, Date.now() - this._drainStartedAt)
            : 0;

        this._shutdownDurationMs = durationMs;

        this._metricsService?.record?.("shutdownDuration", durationMs);

        if (this._forcedShutdown) {

            this._metricsService?.increment?.("forcedShutdown");

        }

        this._transition(APPLICATION_LIFECYCLE.STOPPED, this._drainReason ?? "stopped");

        this._logger.info(
            `Lifecycle STOPPED | durationMs=${durationMs} | forced=${this._forcedShutdown}`
        );

    }

    getSnapshot() {

        const activity = this._collectActivity();

        return Object.freeze({
            state: this._state,
            ready: this._state === APPLICATION_LIFECYCLE.RUNNING,
            acceptingNewWork: this.isAcceptingNewWork(),
            draining: this.isDraining(),
            shuttingDown: this._state === APPLICATION_LIFECYCLE.DRAINING
                || this._state === APPLICATION_LIFECYCLE.STOPPED,
            drainReason: this._drainReason,
            drainStartedAt: this._drainStartedAt,
            gracefulShutdownTimeoutMs: this._gracefulShutdownTimeoutMs,
            forcedShutdown: this._forcedShutdown,
            shutdownDurationMs: this._shutdownDurationMs,
            activity: Object.freeze({ ...activity })
        });

    }

    async _waitForDrainCompletion() {

        const startedAt = this._drainStartedAt ?? Date.now();

        const deadline = startedAt + this._gracefulShutdownTimeoutMs;

        let remaining = this._collectActivity();

        this._logRemainingResources(remaining);

        while (Date.now() < deadline) {

            remaining = this._collectActivity();

            if (this._isIdle(remaining)) {

                const durationMs = Math.max(0, Date.now() - startedAt);

                this._logger.info(
                    `Graceful drain complete | durationMs=${durationMs} | remaining idle`
                );

                this._logRemainingResources(remaining);

                return {
                    forced: false,
                    durationMs,
                    remaining,
                    reason: this._drainReason ?? "shutdown"
                };

            }

            await this._sleep(this._pollIntervalMs);

        }

        remaining = this._collectActivity();

        this._forcedShutdown = true;

        const durationMs = Math.max(0, Date.now() - startedAt);

        this._logger.warn(
            `Graceful shutdown timeout expired (${this._gracefulShutdownTimeoutMs}ms) — forcing shutdown`
        );

        this._logRemainingResources(remaining);

        return {
            forced: true,
            durationMs,
            remaining,
            reason: this._drainReason ?? "shutdown"
        };

    }

    _collectActivity() {

        let raw = {};

        if (this._activityProvider) {

            try {

                raw = this._activityProvider() ?? {};

            } catch (error) {

                this._logger.error(
                    `Lifecycle activity provider failed | ${error.message}`
                );

                raw = {};

            }

        }

        const activity = {
            setupSessions: Number(raw.setupSessions) || 0,
            activeGames: Number(raw.activeGames) || 0,
            paymentSessions: Number(raw.paymentSessions) || 0,
            pendingPayments: Number(raw.pendingPayments) || 0,
            settlements: Number(raw.settlements) || 0,
            pendingTeardowns: Number(raw.pendingTeardowns) || 0,
            activeSimulations: Number(raw.activeSimulations) || 0,
            recoverySessions: Number(raw.recoverySessions) || 0,
            resultSessions: Number(raw.resultSessions) || 0
        };

        this._lastActivity = activity;

        return activity;

    }

    _isIdle(activity) {

        return activity.setupSessions === 0
            && activity.activeGames === 0
            && activity.paymentSessions === 0
            && activity.pendingPayments === 0
            && activity.settlements === 0
            && activity.pendingTeardowns === 0
            && activity.activeSimulations === 0
            && activity.recoverySessions === 0
            && activity.resultSessions === 0;

    }

    _emptyActivity() {

        return {
            setupSessions: 0,
            activeGames: 0,
            paymentSessions: 0,
            pendingPayments: 0,
            settlements: 0,
            pendingTeardowns: 0,
            activeSimulations: 0,
            recoverySessions: 0,
            resultSessions: 0
        };

    }

    _logRemainingResources(activity) {

        this._logger.info(
            "Drain activity | "
                + `setup=${activity.setupSessions} `
                + `games=${activity.activeGames} `
                + `paymentSessions=${activity.paymentSessions} `
                + `pendingPayments=${activity.pendingPayments} `
                + `settlements=${activity.settlements} `
                + `teardowns=${activity.pendingTeardowns} `
                + `simulations=${activity.activeSimulations} `
                + `recovery=${activity.recoverySessions} `
                + `resultSessions=${activity.resultSessions}`
        );

    }

    _transition(nextState, reason) {

        const previous = this._state;

        this._state = nextState;

        this._healthService?.setLifecycleState?.(nextState);

        this._loggingManager?.setLifecycleState?.(nextState);

        this._logger.info(
            `Lifecycle ${previous} → ${nextState} | reason=${reason}`,
            { lifecycleState: nextState, previousLifecycleState: previous }
        );

        this._loggingManager?.audit?.(
            `lifecycle ${previous} → ${nextState}`,
            {
                lifecycleState: nextState,
                previousLifecycleState: previous,
                reason
            }
        );

    }

    _sleep(ms) {

        return new Promise((resolve) => {

            setTimeout(resolve, ms);

        });

    }

}
