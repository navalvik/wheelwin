/**
 * R8.0E — Launch readiness gauges for MonitoringManager.
 */

import { MetricCollector } from "./MetricCollector.js";
import {
    LAUNCH_LIFECYCLE,
    LAUNCH_DECISION
} from "../launch/LaunchConfiguration.js";

export class LaunchMetricsCollectorMonitor extends MetricCollector {

    constructor({ intervalMs = 5000 }) {

        super({ name: "launch", intervalMs });

    }

    collect({ registry, providers }) {

        const status = providers?.launchReadinessManager?.getSafeStatus?.()
            ?? null;

        if (!status) {

            registry.setGauge("launch.available", 0);

            registry.setGauge("launch.ready", 0);

            return;

        }

        registry.setGauge("launch.available", 1);

        registry.setGauge(
            "launch.ready",
            status.productionReady || status.openBetaReady ? 1 : 0
        );

        registry.setGauge(
            "launch.blockers",
            status.blockerSummary?.total ?? 0
        );

        registry.setGauge(
            "launch.gates",
            status.gateSummary?.total ?? 0
        );

        registry.setGauge(
            "launch.score",
            status.readinessScore ?? 0
        );

        registry.setGauge(
            "launch.critical_blockers",
            status.blockerSummary?.critical ?? 0
        );

        registry.setGauge(
            "launch.high_blockers",
            status.blockerSummary?.high ?? 0
        );

        registry.setGauge(
            "launch.open_beta_ready",
            status.openBetaReady ? 1 : 0
        );

        registry.setGauge(
            "launch.ga_ready",
            status.gaReady ? 1 : 0
        );

        registry.setGauge(
            "launch.production_ready",
            status.productionReady ? 1 : 0
        );

        const lifecycle = status.lifecycle ?? LAUNCH_LIFECYCLE.NOT_EVALUATED;

        for (const name of Object.values(LAUNCH_LIFECYCLE)) {

            registry.setGauge(
                `launch.lifecycle_${name.toLowerCase()}`,
                lifecycle === name ? 1 : 0
            );

        }

        const decision = status.decision ?? LAUNCH_DECISION.NOT_READY;

        for (const name of Object.values(LAUNCH_DECISION)) {

            registry.setGauge(
                `launch.decision_${name.toLowerCase()}`,
                decision === name ? 1 : 0
            );

        }

    }

}

// Alias matching deliverable name used by MonitoringManager import style
export { LaunchMetricsCollectorMonitor as LaunchReadinessMetricsCollector };
