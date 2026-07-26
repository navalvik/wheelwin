/**
 * R9.0B — Continuous KPI collection from read-only sources.
 */

import { createKPIResult } from "./models/KPIResult.js";

function counter(snapshot, name) {

    return Number(snapshot?.counters?.[name]) || 0;

}

function avgMs(metric) {

    return Number(metric?.averageMs) || 0;

}

function maxMs(metric) {

    return Number(metric?.maxMs) || 0;

}

export class ServiceKPIManager {

    constructor() {

        this._latest = null;

        this._serviceStartedAt = Date.now();

    }

    setServiceStartedAt(ts) {

        this._serviceStartedAt = Number.isFinite(ts) ? ts : Date.now();

    }

    /**
     * @param {object} ctx
     */
    collect(ctx = {}) {

        const metrics = ctx.metricsService?.getSnapshot?.()
            ?? ctx.metricsSnapshot
            ?? null;

        const closedBeta = ctx.closedBeta ?? {};

        const monitoring = ctx.monitoringSnapshot ?? null;

        const mem = process.memoryUsage();

        const heapUsed = mem.heapUsed;

        const heapTotal = Math.max(1, mem.heapTotal);

        const gamesStarted = counter(metrics, "games.started");

        const gamesCompleted = counter(metrics, "games.completed");

        const reconnects = counter(metrics, "reconnects");

        const paymentsCompleted = counter(metrics, "payments.completed");

        const paymentsFailed = counter(metrics, "payments.failed");

        const paymentTotal = paymentsCompleted + paymentsFailed;

        const crashes = Number(closedBeta.crashCount)
            || Number(closedBeta.crashes?.total)
            || 0;

        const crashRate = gamesCompleted > 0
            ? Number((crashes / gamesCompleted).toFixed(4))
            : (Number(closedBeta.crashRate) || 0);

        const recoveryRate = Number(
            closedBeta.telemetry?.recoverySuccessRate
        );

        const settlementRate = Number(
            closedBeta.telemetry?.settlementSuccessRate
        );

        const paymentRate = paymentTotal > 0
            ? Number((paymentsCompleted / paymentTotal).toFixed(4))
            : (Number.isFinite(settlementRate) ? settlementRate : 1);

        const latencyAvg = avgMs(metrics?.metrics?.["network.latency"])
            || Number(closedBeta.telemetry?.averageLatencyMs)
            || 0;

        const latencyPeak = maxMs(metrics?.metrics?.["network.latency"])
            || latencyAvg;

        const reconnectRate = gamesStarted > 0
            ? Number((reconnects / gamesStarted).toFixed(4))
            : 0;

        const errorRate = gamesStarted > 0
            ? Number(
                (
                    Math.max(0, gamesStarted - gamesCompleted) / gamesStarted
                ).toFixed(4)
            )
            : 0;

        // Soft availability proxy from health + crash/error rates
        const healthOk = ctx.health?.ready === true
            || ctx.health?.status === "ok"
            || ctx.health == null;

        let availability = healthOk ? 1 : 0.9;

        availability = Math.max(
            0,
            Math.min(1, availability - (crashRate * 0.5) - (errorRate * 0.2))
        );

        const eventLoop = Number(
            monitoring?.gauges?.["system.event_loop_lag_ms"]
        ) || avgMs(metrics?.metrics?.["eventloop.lag"]) || 0;

        this._latest = createKPIResult({
            collectedAt: Date.now(),
            serviceUptimeMs: Math.max(0, Date.now() - this._serviceStartedAt),
            availability: Number(availability.toFixed(4)),
            averageLatencyMs: latencyAvg,
            peakLatencyMs: latencyPeak,
            errorRate,
            crashRate,
            recoverySuccessRate: Number.isFinite(recoveryRate)
                ? recoveryRate
                : 1,
            paymentSuccessRate: paymentRate,
            settlementSuccessRate: Number.isFinite(settlementRate)
                ? settlementRate
                : paymentRate,
            reconnectRate,
            cpuUtilization: Number(
                monitoring?.gauges?.["system.cpu_utilization"]
            ) || 0,
            memoryUtilization: Number(
                (heapUsed / heapTotal).toFixed(4)
            ),
            eventLoopLatencyMs: eventLoop,
            averageGameDurationMs:
                avgMs(metrics?.metrics?.["game.duration"])
                || Number(closedBeta.telemetry?.averageGameDurationMs)
                || 0,
            averageSessionDurationMs:
                avgMs(metrics?.metrics?.["session.duration"]) || 0,
            dailyActiveSessions:
                ctx.activeSessions
                ?? closedBeta.activeSessions
                ?? 0
        });

        return this._latest;

    }

    getLatest() {

        return this._latest;

    }

}
