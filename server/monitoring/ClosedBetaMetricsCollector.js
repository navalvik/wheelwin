/**
 * R8.0D — Closed Beta gauges for MonitoringManager.
 */

import { MetricCollector } from "./MetricCollector.js";
import { BETA_LIFECYCLE, BETA_READINESS } from "../beta/BetaConfiguration.js";

export class ClosedBetaMetricsCollector extends MetricCollector {

    constructor({ intervalMs = 5000 }) {

        super({ name: "closed_beta", intervalMs });

    }

    collect({ registry, providers }) {

        const status = providers?.closedBetaManager?.getSafeStatus?.() ?? null;

        if (!status) {

            registry.setGauge("closed_beta.available", 0);

            return;

        }

        registry.setGauge("closed_beta.available", 1);

        registry.setGauge(
            "closed_beta.enabled",
            status.enabled ? 1 : 0
        );

        registry.setGauge(
            "closed_beta.participants",
            status.participantCount ?? 0
        );

        registry.setGauge(
            "closed_beta.active_sessions",
            status.activeSessions ?? 0
        );

        registry.setGauge(
            "closed_beta.incidents",
            status.incidentCount ?? 0
        );

        registry.setGauge(
            "closed_beta.crashes",
            status.crashCount ?? 0
        );

        registry.setGauge(
            "closed_beta.feedback",
            status.feedbackCount ?? 0
        );

        registry.setGauge(
            "closed_beta.readiness_score",
            status.readinessScore ?? 0
        );

        registry.setGauge(
            "closed_beta.crash_rate_x10000",
            Math.round((status.crashRate ?? 0) * 10000)
        );

        const lifecycle = status.lifecycle ?? BETA_LIFECYCLE.NOT_STARTED;

        for (const name of Object.values(BETA_LIFECYCLE)) {

            registry.setGauge(
                `closed_beta.lifecycle_${name.toLowerCase()}`,
                lifecycle === name ? 1 : 0
            );

        }

        const readiness = status.readiness ?? BETA_READINESS.NOT_READY;

        for (const name of Object.values(BETA_READINESS)) {

            registry.setGauge(
                `closed_beta.readiness_${name.toLowerCase()}`,
                readiness === name ? 1 : 0
            );

        }

    }

}
