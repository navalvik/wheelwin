/**
 * R9.0A — GA gauges for MonitoringManager.
 */

import { MetricCollector } from "./MetricCollector.js";
import {
    GA_LIFECYCLE,
    ROLLOUT_STAGES,
    VERIFICATION_STATUS
} from "../ga/ProductionConfiguration.js";

export class GaMetricsCollector extends MetricCollector {

    constructor({ intervalMs = 5000 }) {

        super({ name: "ga", intervalMs });

    }

    collect({ registry, providers }) {

        const status = providers?.generalAvailabilityManager?.getSafeStatus?.()
            ?? null;

        if (!status) {

            registry.setGauge("ga.available", 0);

            return;

        }

        registry.setGauge("ga.available", 1);

        registry.setGauge(
            "ga.enabled",
            status.enabled ? 1 : 0
        );

        registry.setGauge(
            "ga.score",
            status.operationalScore ?? 0
        );

        registry.setGauge(
            "ga.verification_score",
            status.verificationScore ?? 0
        );

        registry.setGauge(
            "ga.rollback_recommendation",
            status.rollbackRecommended ? 1 : 0
        );

        registry.setGauge(
            "ga.rollout_complete",
            status.rolloutComplete ? 1 : 0
        );

        registry.setGauge(
            "ga.uptime_ms",
            status.gaUptimeMs ?? 0
        );

        // Encode release presence
        registry.setGauge(
            "ga.release",
            status.releaseVersion ? 1 : 0
        );

        registry.setGauge(
            "ga.verification",
            status.verificationStatus === VERIFICATION_STATUS.PASSED
                || status.verificationStatus
                    === VERIFICATION_STATUS.PASSED_WITH_WARNINGS
                ? 1
                : 0
        );

        registry.setGauge(
            "ga.rollout",
            status.rolloutStage === ROLLOUT_STAGES.COMPLETED ? 1 : 0
        );

        const lifecycle = status.lifecycle ?? GA_LIFECYCLE.READY_FOR_RELEASE;

        for (const name of Object.values(GA_LIFECYCLE)) {

            registry.setGauge(
                `ga.lifecycle_${name.toLowerCase()}`,
                lifecycle === name ? 1 : 0
            );

        }

        for (const name of Object.values(VERIFICATION_STATUS)) {

            registry.setGauge(
                `ga.verification_${name.toLowerCase()}`,
                status.verificationStatus === name ? 1 : 0
            );

        }

    }

}
