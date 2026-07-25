/**
 * R7.0G — Central health probe coordinator (cached, lock-free reads).
 *
 * Existing HealthService delegates probe fields here.
 */

import { ProbeRegistry } from "./ProbeRegistry.js";
import { StartupProbe } from "./health/StartupProbe.js";
import { LivenessProbe } from "./health/LivenessProbe.js";
import { ReadinessProbe } from "./health/ReadinessProbe.js";
import { OverallHealthProbe } from "./health/OverallHealthProbe.js";
import { StartupManager } from "./StartupManager.js";
import { LivenessManager } from "./LivenessManager.js";
import { ReadinessManager } from "./ReadinessManager.js";
import { DeploymentProfile } from "./DeploymentProfile.js";
import { LoggingManager } from "../logging/LoggingManager.js";
import { LOG_LEVELS } from "../logging/levels.js";

export class HealthManager {

    static _instance = null;

    constructor() {

        this._enabled = false;

        this._profile = null;

        this._providers = null;

        this._registry = new ProbeRegistry();

        this._startupProbe = null;

        this._livenessProbe = null;

        this._readinessProbe = null;

        this._healthProbe = null;

        this._startupManager = null;

        this._livenessManager = null;

        this._readinessManager = null;

        this._timer = null;

        this._cache = null;

        this._stats = {
            refreshes: 0,
            readinessTransitions: 0,
            healthTransitions: 0,
            lastRefreshMs: 0,
            probeFailures: 0
        };

        this._previousHealthOverall = null;

        this._previousReady = null;

        this._unrecoverableFailure = false;

        this._unrecoverableFailureReason = null;

    }

    static getInstance() {

        if (!HealthManager._instance) {

            HealthManager._instance = new HealthManager();

        }

        return HealthManager._instance;

    }

    static resetForTests() {

        if (HealthManager._instance) {

            HealthManager._instance.shutdown();

        }

        HealthManager._instance = null;

    }

    /**
     * @param {{
     *   enabled?: boolean,
     *   profile?: import("./DeploymentProfile.js").DeploymentProfile,
     *   probeRefreshIntervalMs?: number,
     *   readinessEnabled?: boolean,
     *   livenessEnabled?: boolean,
     *   startupEnabled?: boolean,
     *   providers?: object
     * }} config
     */
    initialize(config = {}) {

        this.shutdown();

        this._enabled = config.enabled !== false;

        this._profile = config.profile
            ?? DeploymentProfile.resolve("development");

        this._providers = config.providers ?? {};

        const refreshMs = config.probeRefreshIntervalMs
            ?? this._profile.probeRefreshIntervalMs;

        this._startupProbe = new StartupProbe();

        this._livenessProbe = new LivenessProbe();

        this._readinessProbe = new ReadinessProbe({
            strict: this._profile.readinessStrict
        });

        this._healthProbe = new OverallHealthProbe();

        this._registry = new ProbeRegistry();

        if (config.startupEnabled !== false) {

            this._registry.register("startup", this._startupProbe);

        }

        if (config.livenessEnabled !== false) {

            this._registry.register("liveness", this._livenessProbe);

        }

        if (config.readinessEnabled !== false) {

            this._registry.register("readiness", this._readinessProbe);

        }

        this._registry.register("health", this._healthProbe);

        this._startupManager = new StartupManager({ probe: this._startupProbe });

        this._livenessManager = new LivenessManager({ probe: this._livenessProbe });

        this._readinessManager = new ReadinessManager({ probe: this._readinessProbe });

        this.refresh();

        if (this._enabled) {

            this._timer = setInterval(() => {

                this.refresh();

            }, Math.max(50, refreshMs));

            if (typeof this._timer.unref === "function") {

                this._timer.unref();

            }

        }

        this._log("info", "HealthManager initialized", {
            profile: this._profile.name,
            refreshMs
        });

        return this;

    }

    /**
     * Collect signals + evaluate probes. Safe to call frequently.
     */
    refresh() {

        const started = performance.now();

        const signals = this._collectSignals();

        const startup = this._startupManager.evaluate(signals);

        const liveness = this._livenessManager.evaluate(signals);

        const readiness = this._readinessManager.evaluate(signals);

        const health = this._healthProbe.evaluate(signals);

        if (this._readinessManager.didTransition()) {

            this._stats.readinessTransitions += 1;

            this._log("info", "Readiness changed", {
                ready: readiness.ok,
                reason: readiness.reason
            });

        }

        const overall = health.details?.overall ?? null;

        if (this._previousHealthOverall != null
            && this._previousHealthOverall !== overall) {

            this._stats.healthTransitions += 1;

            this._log("warn", "Health degradation", {
                from: this._previousHealthOverall,
                to: overall
            });

        }

        this._previousHealthOverall = overall;

        this._previousReady = readiness.ok;

        if (!liveness.ok) {

            this._log("fatal", "Liveness failure", {
                reason: liveness.reason
            });

        }

        const latencyMs = Number((performance.now() - started).toFixed(3));

        this._stats.refreshes += 1;

        this._stats.lastRefreshMs = latencyMs;

        this._stats.probeFailures = [startup, liveness, readiness, health]
            .filter((r) => r.ok !== true).length;

        this._cache = Object.freeze({
            refreshedAt: Date.now(),
            refreshLatencyMs: latencyMs,
            profile: this._profile.toSafeSummary(),
            startup: Object.freeze({
                ok: startup.ok,
                status: startup.status,
                reason: startup.reason,
                complete: this._startupManager.isComplete(),
                details: startup.details
            }),
            liveness: Object.freeze({
                ok: liveness.ok,
                status: liveness.status,
                reason: liveness.reason,
                details: liveness.details
            }),
            readiness: Object.freeze({
                ok: readiness.ok,
                status: readiness.status,
                reason: readiness.reason,
                details: readiness.details
            }),
            health: Object.freeze({
                ok: health.ok,
                status: health.status,
                overall: overall,
                reason: health.reason,
                details: health.details
            }),
            probes: Object.freeze({
                startup: this._startupProbe.getMetrics(),
                liveness: this._livenessProbe.getMetrics(),
                readiness: this._readinessProbe.getMetrics(),
                health: this._healthProbe.getMetrics()
            }),
            stats: Object.freeze({ ...this._stats })
        });

        return this._cache;

    }

    /**
     * Lock-free cached snapshot for HTTP endpoints.
     */
    getCachedSnapshot() {

        if (!this._cache) {

            return this.refresh();

        }

        return this._cache;

    }

    getStartupResponse() {

        const cache = this.getCachedSnapshot();

        return Object.freeze({
            startup: cache.startup.ok === true,
            status: cache.startup.ok ? "ok" : "starting",
            reason: cache.startup.reason,
            complete: cache.startup.complete === true,
            profile: cache.profile.name,
            checkedAt: cache.refreshedAt
        });

    }

    getLivenessResponse() {

        const cache = this.getCachedSnapshot();

        return Object.freeze({
            live: cache.liveness.ok === true,
            status: cache.liveness.ok ? "ok" : "dead",
            reason: cache.liveness.reason,
            profile: cache.profile.name,
            checkedAt: cache.refreshedAt
        });

    }

    getReadinessResponse() {

        const cache = this.getCachedSnapshot();

        return Object.freeze({
            ready: cache.readiness.ok === true,
            status: cache.readiness.ok ? "ok" : "not_ready",
            reason: cache.readiness.reason,
            profile: cache.profile.name,
            checkedAt: cache.refreshedAt
        });

    }

    /**
     * Safe status for HealthService / console (no secrets / stacks / paths).
     */
    getSafeStatus() {

        const cache = this.getCachedSnapshot();

        return Object.freeze({
            enabled: this._enabled,
            profile: cache.profile.name,
            startup: cache.startup.ok,
            live: cache.liveness.ok,
            ready: cache.readiness.ok,
            overall: cache.health.overall,
            http: cache.health.details?.components?.http ?? null,
            socket: cache.health.details?.components?.socket ?? null,
            refreshLatencyMs: cache.refreshLatencyMs,
            readinessTransitions: cache.stats.readinessTransitions,
            healthTransitions: cache.stats.healthTransitions,
            probeFailures: cache.stats.probeFailures
        });

    }

    markUnrecoverableFailure(reason = "unrecoverable_failure") {

        this._unrecoverableFailure = true;

        this._unrecoverableFailureReason = reason;

        this.refresh();

    }

    clearUnrecoverableFailure() {

        this._unrecoverableFailure = false;

        this._unrecoverableFailureReason = null;

    }

    getProfile() {

        return this._profile;

    }

    isEnabled() {

        return this._enabled === true;

    }

    shutdown() {

        if (this._timer) {

            clearInterval(this._timer);

            this._timer = null;

        }

        this._enabled = false;

    }

    _collectSignals() {

        const p = this._providers ?? {};

        const memory = typeof p.memory === "function"
            ? p.memory()
            : process.memoryUsage();

        return {
            lifecycleState: p.lifecycleState?.() ?? null,
            lifecycleInitialized: p.lifecycleInitialized?.() === true
                || p.lifecycleState?.() != null,
            configurationLoaded: p.configurationLoaded?.() !== false,
            loggingActive: p.loggingActive?.() === true,
            monitoringInitialized: p.monitoringInitialized?.() === true,
            monitoringActive: p.monitoringActive?.() === true,
            monitoringRequired: p.monitoringRequired?.() !== false,
            failurePolicyInitialized: p.failurePolicyInitialized?.() === true,
            httpListening: p.httpListening?.() === true,
            socketListening: p.socketListening?.() === true,
            memory: {
                heapUsed: memory.heapUsed,
                heapTotal: memory.heapTotal,
                rss: memory.rss
            },
            eventLoopDelayMs: p.eventLoopDelayMs?.() ?? null,
            activeGames: p.activeGames?.() ?? 0,
            activeRooms: p.activeRooms?.() ?? 0,
            unrecoverableFailure: this._unrecoverableFailure,
            unrecoverableFailureReason: this._unrecoverableFailureReason
        };

    }

    _log(level, message, fields) {

        const manager = LoggingManager.getInstance();

        if (!manager.isInitialized()) {

            return;

        }

        const mapped = level === "fatal"
            ? LOG_LEVELS.FATAL
            : level === "warn"
                ? LOG_LEVELS.WARN
                : LOG_LEVELS.INFO;

        manager.write({
            level: mapped,
            service: "wheelwin-deployment-health",
            message,
            fields
        });

    }

}
