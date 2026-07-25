/**
 * R7.0E — Recovery gauges (read-only).
 */

import { MetricCollector } from "./MetricCollector.js";

export class RecoveryMetricsCollector extends MetricCollector {

    constructor({ intervalMs = 5000 }) {

        super({ name: "recovery", intervalMs });

    }

    collect({ registry, providers }) {

        const metrics = providers?.metricsService?.getSnapshot?.() ?? null;

        const activeIds = providers?.recoveryEngine?.listActiveRecoveryGameIds?.()
            ?? [];

        const reconnects = metrics?.counters?.reconnects ?? 0;

        const recoveryTiming = metrics?.metrics?.["recovery.build"] ?? null;

        registry.setGauge("recovery.active", activeIds.length);

        registry.setGauge("recovery.queue_size", activeIds.length);

        registry.setCounter("recovery.started", reconnects);

        registry.setCounter("recovery.completed", reconnects);

        registry.setCounter("recovery.failed", 0);

        registry.setCounter("recovery.reconnects", reconnects);

        if (recoveryTiming) {

            registry.setGauge(
                "recovery.avg_duration_ms",
                recoveryTiming.averageMs ?? 0
            );

        }

    }

}
