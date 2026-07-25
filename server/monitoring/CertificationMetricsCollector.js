/**
 * R8.0C — Certification gauges for MonitoringManager.
 */

import { MetricCollector } from "./MetricCollector.js";
import { CERTIFICATION_STATUS } from "../certification/CertificationStatus.js";

export class CertificationMetricsCollector extends MetricCollector {

    constructor({ intervalMs = 5000 }) {

        super({ name: "certification", intervalMs });

    }

    collect({ registry, providers }) {

        const status = providers?.certificationManager?.getSafeStatus?.() ?? null;

        if (!status) {

            registry.setGauge("certification.available", 0);

            return;

        }

        registry.setGauge("certification.available", 1);

        registry.setGauge(
            "certification.beta_ready",
            status.betaReady ? 1 : 0
        );

        registry.setGauge("certification.warnings", status.warnings ?? 0);

        registry.setGauge("certification.failures", status.failures ?? 0);

        registry.setGauge(
            "certification.duration_ms",
            status.durationMs ?? 0
        );

        const state = status.status ?? CERTIFICATION_STATUS.NOT_CERTIFIED;

        for (const name of Object.values(CERTIFICATION_STATUS)) {

            registry.setGauge(
                `certification.status_${name.toLowerCase()}`,
                state === name ? 1 : 0
            );

        }

    }

}
