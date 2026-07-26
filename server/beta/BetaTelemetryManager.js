/**
 * R8.0D — Observational telemetry aggregation (read-only sources).
 */

import { freezeTelemetrySnapshot } from "./models/BetaTelemetrySnapshot.js";

function avgMs(metric) {

    if (!metric || typeof metric !== "object") {

        return 0;

    }

    return Number(metric.averageMs) || 0;

}

function counter(snapshot, name) {

    return Number(snapshot?.counters?.[name]) || 0;

}

function gauge(mon, name) {

    return Number(mon?.gauges?.[name]
        ?? mon?.runtime?.[name]
        ?? mon?.gameplay?.[name]
        ?? 0) || 0;

}

export class BetaTelemetryManager {

    constructor() {

        /** @type {ReturnType<typeof freezeTelemetrySnapshot>|null} */
        this._latest = null;

        this._providers = null;

    }

    /**
     * @param {object} providers read-only accessors
     */
    setProviders(providers) {

        this._providers = providers ?? null;

    }

    getLatest() {

        return this._latest;

    }

    /**
     * Pull read-only snapshots from MetricsService / MonitoringManager / managers.
     * Never mutates gameplay engines.
     */
    collect() {

        const providers = this._providers ?? {};

        const metrics = providers.metricsService?.getSnapshot?.() ?? null;

        const monitoring = providers.monitoringManager?.getSnapshot?.()
            ?? providers.monitoringSnapshot?.()
            ?? null;

        const gamesStarted = counter(metrics, "games.started");

        const gamesCompleted = counter(metrics, "games.completed");

        const reconnects = counter(metrics, "reconnects");

        const paymentsCompleted = counter(metrics, "payments.completed");

        const paymentsFailed = counter(metrics, "payments.failed");

        const paymentsInitiated = paymentsCompleted + paymentsFailed
            + counter(metrics, "payments.initiated");

        const recoveryAttempts = gauge(monitoring, "recovery.attempts")
            || counter(metrics, "recovery.attempts");

        const recoveryFailures = gauge(monitoring, "recovery.failures")
            || counter(metrics, "recovery.failures");

        const recoverySuccesses = Math.max(
            0,
            recoveryAttempts - recoveryFailures
        );

        const recoverySuccessRate = recoveryAttempts > 0
            ? Number((recoverySuccesses / recoveryAttempts).toFixed(4))
            : 1;

        const paymentTotal = paymentsCompleted + paymentsFailed;

        const settlementSuccessRate = paymentTotal > 0
            ? Number((paymentsCompleted / paymentTotal).toFixed(4))
            : 1;

        const activeSessions =
            providers.gameManager?.getGames?.()?.length
            ?? gauge(monitoring, "gameplay.active_games")
            ?? 0;

        const abandoned = Math.max(0, gamesStarted - gamesCompleted);

        const snapshot = freezeTelemetrySnapshot({
            collectedAt: Date.now(),
            activeSessions,
            session: {
                gamesStarted,
                gamesCompleted,
                gamesAbandoned: abandoned,
                reconnectCount: reconnects,
                offlineRecoveryCount:
                    counter(metrics, "recovery.offline")
                    || gauge(monitoring, "recovery.offline"),
                averageSessionDurationMs:
                    avgMs(metrics?.metrics?.["session.duration"]),
                averageGameDurationMs:
                    avgMs(metrics?.metrics?.["game.duration"]),
                averageSetupDurationMs:
                    avgMs(metrics?.metrics?.["setup.duration"]),
                averagePaymentDurationMs:
                    avgMs(metrics?.metrics?.["payment.process"]),
                averageReadyPhaseDurationMs:
                    avgMs(metrics?.metrics?.["phase.ready"]),
                averageSpeedPhaseDurationMs:
                    avgMs(metrics?.metrics?.["phase.speed"]),
                averageBrakePhaseDurationMs:
                    avgMs(metrics?.metrics?.["phase.brake"]),
                averageResultPhaseDurationMs:
                    avgMs(metrics?.metrics?.["phase.result"])
            },
            network: {
                socketReconnects: reconnects,
                packetLossEstimate:
                    gauge(monitoring, "network.packet_loss_estimate"),
                connectionFailures:
                    counter(metrics, "connection.failures")
                    || gauge(monitoring, "network.connection_failures"),
                averageLatencyMs:
                    avgMs(metrics?.metrics?.["network.latency"])
                    || gauge(monitoring, "network.avg_latency_ms"),
                maximumLatencyMs:
                    Number(metrics?.metrics?.["network.latency"]?.maxMs) || 0
                    || gauge(monitoring, "network.max_latency_ms")
            },
            recovery: {
                recoveryAttempts,
                recoverySuccessRate,
                recoveryFailures,
                stateRestorationCount:
                    counter(metrics, "recovery.restored")
                    || gauge(monitoring, "recovery.state_restorations")
            },
            payment: {
                paymentsInitiated,
                paymentsCompleted,
                paymentsFailed,
                settlementSuccessRate,
                settlementDurationMs:
                    avgMs(metrics?.metrics?.["settlement.duration"])
            },
            gameplay: {
                wheelSpins:
                    counter(metrics, "wheel.spins")
                    || gauge(monitoring, "gameplay.wheel_spins"),
                winnerDistribution: {},
                configurationValidationFailures:
                    counter(metrics, "config.validation_failures"),
                authoritativeSyncFailures:
                    counter(metrics, "authority.sync_failures"),
                desynchronizationCount:
                    counter(metrics, "authority.desync"),
                physicsAnomalies:
                    counter(metrics, "physics.anomalies")
                    || gauge(monitoring, "simulation.physics_anomalies")
            }
        });

        this._latest = snapshot;

        return snapshot;

    }

}
