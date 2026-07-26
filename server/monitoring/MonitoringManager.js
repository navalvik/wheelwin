/**
 * R7.0E — Central monitoring coordinator (observational only).
 */

import { MetricsRegistry } from "./MetricsRegistry.js";
import { MetricsScheduler } from "./MetricsScheduler.js";
import { MetricsSnapshot } from "./MetricsSnapshot.js";
import { RuntimeMetricsCollector } from "./RuntimeMetricsCollector.js";
import { GameplayMetricsCollector } from "./GameplayMetricsCollector.js";
import { SimulationMetricsCollector } from "./SimulationMetricsCollector.js";
import { PaymentMetricsCollector } from "./PaymentMetricsCollector.js";
import { RecoveryMetricsCollector } from "./RecoveryMetricsCollector.js";
import { DeveloperMetricsCollector } from "./DeveloperMetricsCollector.js";
import { SystemMetricsCollector } from "./SystemMetricsCollector.js";
import { FailureMetricsCollector } from "./FailureMetricsCollector.js";
import { DeploymentMetricsCollector } from "./DeploymentMetricsCollector.js";
import { ReleaseMetricsCollector } from "./ReleaseMetricsCollector.js";
import { CertificationMetricsCollector } from "./CertificationMetricsCollector.js";
import { ClosedBetaMetricsCollector } from "./ClosedBetaMetricsCollector.js";
import { LaunchReadinessMetricsCollector } from "./LaunchReadinessMetricsCollector.js";
import { GaMetricsCollector } from "./GaMetricsCollector.js";
import { OperationsMetricsCollector } from "./OperationsMetricsCollector.js";
import { GovernancePlatformMetricsCollector } from "./GovernanceMetricsCollector.js";
import { JsonMetricsExporter } from "./exporters/JsonMetricsExporter.js";
import { PrometheusExporter } from "./exporters/PrometheusExporter.js";
import { HealthMetricsProvider } from "./health/HealthMetricsProvider.js";

export class MonitoringManager {

    static _instance = null;

    constructor() {

        this._enabled = false;

        this._running = false;

        this._config = null;

        this._providers = null;

        this._registry = new MetricsRegistry();

        this._scheduler = new MetricsScheduler();

        this._collectors = [];

        this._snapshot = null;

        this._jsonExporter = new JsonMetricsExporter();

        this._prometheusExporter = new PrometheusExporter();

        this._healthProvider = new HealthMetricsProvider(this);

        this._prometheusEnabled = false;

    }

    static getInstance() {

        if (!MonitoringManager._instance) {

            MonitoringManager._instance = new MonitoringManager();

        }

        return MonitoringManager._instance;

    }

    static resetForTests() {

        if (MonitoringManager._instance) {

            MonitoringManager._instance.shutdown();

        }

        MonitoringManager._instance = null;

    }

    /**
     * @param {{
     *   enabled: boolean,
     *   intervals: object,
     *   prometheusEnabled?: boolean,
     *   providers: object
     * }} options
     */
    initialize({
        enabled = true,
        intervals = {},
        prometheusEnabled = false,
        providers = {}
    }) {

        this.shutdown();

        this._enabled = enabled === true;

        this._prometheusEnabled = prometheusEnabled === true;

        this._providers = providers;

        this._config = { intervals };

        if (!this._enabled) {

            this._snapshot = new MetricsSnapshot({
                collectedAt: Date.now(),
                enabled: false,
                collectors: {},
                runtime: {},
                gameplay: {},
                simulation: {},
                payments: {},
                recovery: {},
                developer: {},
                system: {},
                gauges: {},
                counters: {}
            });

            return this;

        }

        this._collectors = [
            new RuntimeMetricsCollector({
                intervalMs: intervals.runtimeMs ?? 1000
            }),
            new GameplayMetricsCollector({
                intervalMs: intervals.gameplayMs ?? 1000
            }),
            new SimulationMetricsCollector({
                intervalMs: intervals.simulationMs ?? 500
            }),
            new PaymentMetricsCollector({
                intervalMs: intervals.paymentMs ?? 5000
            }),
            new RecoveryMetricsCollector({
                intervalMs: intervals.recoveryMs ?? 5000
            }),
            new DeveloperMetricsCollector({
                intervalMs: intervals.systemMs ?? 5000
            }),
            new SystemMetricsCollector({
                intervalMs: intervals.systemMs ?? 5000
            }),
            new FailureMetricsCollector({
                intervalMs: intervals.systemMs ?? 5000
            }),
            new DeploymentMetricsCollector({
                intervalMs: intervals.systemMs ?? 5000
            }),
            new ReleaseMetricsCollector({
                intervalMs: intervals.systemMs ?? 5000
            }),
            new CertificationMetricsCollector({
                intervalMs: intervals.systemMs ?? 5000
            }),
            new ClosedBetaMetricsCollector({
                intervalMs: intervals.systemMs ?? 5000
            }),
            new LaunchReadinessMetricsCollector({
                intervalMs: intervals.systemMs ?? 5000
            }),
            new GaMetricsCollector({
                intervalMs: intervals.systemMs ?? 5000
            }),
            new OperationsMetricsCollector({
                intervalMs: intervals.systemMs ?? 5000
            }),
            new GovernancePlatformMetricsCollector({
                intervalMs: intervals.systemMs ?? 5000
            })
        ];

        for (const collector of this._collectors) {

            this._scheduler.register(collector, (c) => this._runCollector(c));

            // Prime once immediately (async)
            setImmediate(() => this._runCollector(collector));

        }

        this._running = true;

        return this;

    }

    start() {

        // initialize already starts scheduler
        return this;

    }

    isEnabled() {

        return this._enabled === true;

    }

    isRunning() {

        return this._running === true && this._enabled === true;

    }

    isPrometheusEnabled() {

        return this._prometheusEnabled === true && this._enabled === true;

    }

    getHealthStatus() {

        return this._healthProvider.getStatus();

    }

    getSnapshot() {

        return this._snapshot;

    }

    getJsonExport() {

        const snapshot = this._snapshot
            ?? new MetricsSnapshot({
                collectedAt: Date.now(),
                enabled: this._enabled,
                collectors: {},
                runtime: {},
                gameplay: {},
                simulation: {},
                payments: {},
                recovery: {},
                developer: {},
                system: {},
                gauges: {},
                counters: {}
            });

        return this._jsonExporter.export(snapshot);

    }

    getPrometheusText() {

        const snapshot = this._snapshot
            ?? new MetricsSnapshot({
                collectedAt: Date.now(),
                enabled: this._enabled,
                collectors: {},
                runtime: {},
                gameplay: {},
                simulation: {},
                payments: {},
                recovery: {},
                developer: {},
                system: {},
                gauges: {},
                counters: {}
            });

        return this._prometheusExporter.export(snapshot);

    }

    /**
     * Force all collectors once (tests / freshness).
     */
    collectNow() {

        for (const collector of this._collectors) {

            this._runCollector(collector);

        }

        return this._snapshot;

    }

    shutdown() {

        this._scheduler.clear();

        for (const collector of this._collectors) {

            collector.shutdown?.();

        }

        this._collectors = [];

        this._registry.clear();

        this._running = false;

        this._providers = null;

    }

    _runCollector(collector) {

        if (!this._enabled) {

            return;

        }

        try {

            collector.collect({
                registry: this._registry,
                providers: this._providers,
                now: Date.now()
            });

            collector.markSuccess();

            this._rebuildSnapshot();

        } catch (error) {

            collector.markFailure(error);

            this._rebuildSnapshot();

        }

    }

    _rebuildSnapshot() {

        const { gauges, counters } = this._registry.toObject();

        const collectors = {};

        for (const collector of this._collectors) {

            collectors[collector.name] = collector.getStatus();

        }

        this._snapshot = new MetricsSnapshot({
            collectedAt: Date.now(),
            enabled: this._enabled,
            lifecycleState: this._providers?.lifecycleState?.() ?? null,
            collectors,
            runtime: {
                uptimeMs: gauges["runtime.uptime_ms"] ?? 0,
                cpuPercent: gauges["runtime.cpu_percent"] ?? 0,
                memoryRssBytes: gauges["runtime.memory_rss_bytes"] ?? 0,
                heapUsedBytes: gauges["runtime.heap_used_bytes"] ?? 0,
                heapTotalBytes: gauges["runtime.heap_total_bytes"] ?? 0,
                eventLoopDelayMs: gauges["runtime.event_loop_delay_ms"] ?? 0,
                nodeVersion: process.version,
                environment: this._providers?.environment?.() ?? null,
                profile: this._providers?.profile?.() ?? null,
                version: this._providers?.version?.() ?? null
            },
            gameplay: {
                activeRooms: gauges["gameplay.active_rooms"] ?? 0,
                activeGames: gauges["gameplay.active_games"] ?? 0,
                activePlayers: gauges["gameplay.active_players"] ?? 0,
                activeSetupSessions: gauges["gameplay.active_setup_sessions"] ?? 0,
                gamesCreated: counters["gameplay.games_created"] ?? 0,
                gamesCompleted: counters["gameplay.games_completed"] ?? 0,
                gamesRecovered: counters["gameplay.games_recovered"] ?? 0,
                avgGameDurationMs: gauges["gameplay.avg_game_duration_ms"] ?? 0,
                avgPaymentDurationMs: gauges["gameplay.avg_payment_duration_ms"] ?? 0
            },
            simulation: {
                tickRateHz: gauges["simulation.tick_rate_hz"] ?? 0,
                tickDriftHz: gauges["simulation.tick_drift_hz"] ?? 0,
                physicsUpdatesPerSec:
                    gauges["simulation.physics_updates_per_sec"] ?? 0,
                avgLatencyMs: gauges["simulation.avg_latency_ms"] ?? 0,
                maxLatencyMs: gauges["simulation.max_latency_ms"] ?? 0,
                skippedTicks: gauges["simulation.skipped_ticks"] ?? 0,
                queueSize: gauges["simulation.queue_size"] ?? 0,
                running: gauges["simulation.running"] === 1
            },
            payments: {
                pending: (gauges["payments.pending_sessions"] ?? 0)
                    + (gauges["payments.pending_engine"] ?? 0),
                completed: counters["payments.completed"] ?? 0,
                failed: counters["payments.failed"] ?? 0,
                activeSettlements: gauges["payments.active_settlements"] ?? 0,
                avgDurationMs: gauges["payments.avg_duration_ms"] ?? 0
            },
            recovery: {
                active: gauges["recovery.active"] ?? 0,
                queueSize: gauges["recovery.queue_size"] ?? 0,
                reconnects: counters["recovery.reconnects"] ?? 0,
                avgDurationMs: gauges["recovery.avg_duration_ms"] ?? 0
            },
            developer: {
                consoleConnections: gauges["developer.console_connections"] ?? 0,
                authenticatedSessions:
                    gauges["developer.authenticated_sessions"] ?? 0,
                failedAuthAttempts:
                    counters["developer.failed_auth_attempts"] ?? 0,
                auditEventsBuffered:
                    gauges["developer.audit_events_buffered"] ?? 0,
                logEventsGenerated:
                    counters["developer.log_events_generated"] ?? 0
            },
            failure: {
                policyEnabled: gauges["failure.policy_enabled"] === 1,
                retryQueueSize: gauges["failure.retry_queue_size"] ?? 0,
                escalationCount: gauges["failure.escalation_count"] ?? 0,
                recoverableFailures:
                    gauges["failure.recoverable_failures"] ?? 0,
                fatalFailures: gauges["failure.fatal_failures"] ?? 0,
                circuitsOpen: gauges["failure.circuits_open"] ?? 0,
                circuitsTotal: gauges["failure.circuits_total"] ?? 0,
                retryCount: counters["failure.retry_count"] ?? 0,
                retrySuccess: counters["failure.retry_success"] ?? 0,
                retryFailure: counters["failure.retry_failure"] ?? 0
            },
            deployment: {
                healthEnabled: gauges["deployment.health_enabled"] === 1,
                startupOk: gauges["deployment.startup_ok"] === 1,
                liveOk: gauges["deployment.live_ok"] === 1,
                readyOk: gauges["deployment.ready_ok"] === 1,
                probeLatencyMs: gauges["deployment.probe_latency_ms"] ?? 0,
                probeFailures: gauges["deployment.probe_failures"] ?? 0,
                readinessTransitions:
                    counters["deployment.readiness_transitions"] ?? 0,
                healthTransitions:
                    counters["deployment.health_transitions"] ?? 0,
                profile: gauges["deployment.profile_production"] === 1
                    ? "production"
                    : gauges["deployment.profile_staging"] === 1
                        ? "staging"
                        : gauges["deployment.profile_development"] === 1
                            ? "development"
                            : null
            },
            release: {
                initialized: gauges["release.initialized"] === 1,
                verified: gauges["release.verified"] === 1,
                hasFingerprint: gauges["release.has_fingerprint"] === 1,
                buildTimestampMs: gauges["release.build_timestamp_ms"] ?? null,
                channel: gauges["release.channel_production"] === 1
                    ? "production"
                    : gauges["release.channel_beta"] === 1
                        ? "beta"
                        : gauges["release.channel_rc"] === 1
                            ? "rc"
                            : gauges["release.channel_internal"] === 1
                                ? "internal"
                                : gauges["release.channel_development"] === 1
                                    ? "development"
                                    : null
            },
            certification: {
                available: gauges["certification.available"] === 1,
                betaReady: gauges["certification.beta_ready"] === 1,
                warnings: gauges["certification.warnings"] ?? 0,
                failures: gauges["certification.failures"] ?? 0,
                durationMs: gauges["certification.duration_ms"] ?? 0,
                status: gauges["certification.status_passed"] === 1
                    ? "PASSED"
                    : gauges["certification.status_passed_with_warnings"] === 1
                        ? "PASSED_WITH_WARNINGS"
                        : gauges["certification.status_failed"] === 1
                            ? "FAILED"
                            : gauges["certification.status_running"] === 1
                                ? "RUNNING"
                                : "NOT_CERTIFIED"
            },
            system: {
                openSockets: gauges["system.open_sockets"] ?? 0,
                socketioClients: gauges["system.socketio_clients"] ?? 0,
                httpRequestsPerSec: gauges["system.http_requests_per_sec"] ?? 0,
                httpAvgLatencyMs: gauges["system.http_avg_latency_ms"] ?? 0,
                httpErrorRate: gauges["system.http_error_rate"] ?? 0,
                warningsPerSec: gauges["system.warnings_per_sec"] ?? 0,
                httpRequestsTotal: counters["system.http_requests_total"] ?? 0,
                httpErrorsTotal: counters["system.http_errors_total"] ?? 0,
                activeResources: gauges["system.active_resources"] ?? 0
            },
            gauges,
            counters
        });

    }

}
