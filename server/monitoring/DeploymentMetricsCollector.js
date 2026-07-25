/**
 * R7.0G — Deployment / probe gauges for MonitoringManager.
 */

import { MetricCollector } from "./MetricCollector.js";

export class DeploymentMetricsCollector extends MetricCollector {

    constructor({ intervalMs = 5000 }) {

        super({ name: "deployment", intervalMs });

    }

    collect({ registry, providers }) {

        const status = providers?.deploymentHealth?.getSafeStatus?.()
            ?? providers?.healthManager?.getSafeStatus?.()
            ?? null;

        if (!status) {

            registry.setGauge("deployment.health_enabled", 0);

            return;

        }

        registry.setGauge("deployment.health_enabled", status.enabled ? 1 : 0);

        registry.setGauge("deployment.startup_ok", status.startup ? 1 : 0);

        registry.setGauge("deployment.live_ok", status.live ? 1 : 0);

        registry.setGauge("deployment.ready_ok", status.ready ? 1 : 0);

        registry.setGauge(
            "deployment.probe_latency_ms",
            status.refreshLatencyMs ?? 0
        );

        registry.setGauge(
            "deployment.probe_failures",
            status.probeFailures ?? 0
        );

        registry.setCounter(
            "deployment.readiness_transitions",
            status.readinessTransitions ?? 0
        );

        registry.setCounter(
            "deployment.health_transitions",
            status.healthTransitions ?? 0
        );

        const profile = status.profile ?? "unknown";

        registry.setGauge(
            "deployment.profile_development",
            profile === "development" ? 1 : 0
        );

        registry.setGauge(
            "deployment.profile_staging",
            profile === "staging" ? 1 : 0
        );

        registry.setGauge(
            "deployment.profile_production",
            profile === "production" ? 1 : 0
        );

    }

}
