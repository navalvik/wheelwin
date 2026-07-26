/**
 * R9.0C — Governance gauges for MonitoringManager.
 */

import { MetricCollector } from "./MetricCollector.js";
import { GOVERNANCE_LIFECYCLE } from "../governance/GovernanceConfiguration.js";

export class GovernancePlatformMetricsCollector extends MetricCollector {

    constructor({ intervalMs = 5000 }) {

        super({ name: "governance", intervalMs });

    }

    collect({ registry, providers }) {

        const status = providers?.governanceManager?.getSafeStatus?.()
            ?? null;

        if (!status) {

            registry.setGauge("governance.available", 0);

            return;

        }

        registry.setGauge("governance.available", 1);

        registry.setGauge(
            "governance.score",
            status.governanceScore ?? 0
        );

        registry.setGauge(
            "governance.audit.score",
            status.auditScore ?? 0
        );

        registry.setGauge(
            "governance.compliance.score",
            status.complianceScore ?? 0
        );

        registry.setGauge(
            "governance.compliance.failed",
            status.complianceFailed ?? 0
        );

        registry.setGauge(
            "governance.risk.score",
            status.riskScore ?? 0
        );

        registry.setGauge(
            "governance.risk.critical",
            status.riskCritical ?? 0
        );

        registry.setGauge(
            "governance.review.score",
            status.reviewScore ?? 0
        );

        registry.setGauge(
            "governance.archive.count",
            status.archiveCount ?? 0
        );

        registry.setGauge(
            "governance.trail.count",
            status.trailCount ?? 0
        );

        registry.setGauge(
            "governance.cycle",
            status.cycle ?? 0
        );

        const lifecycle = status.lifecycle
            ?? GOVERNANCE_LIFECYCLE.PLATFORM_ACTIVE;

        for (const name of Object.values(GOVERNANCE_LIFECYCLE)) {

            registry.setGauge(
                `governance.lifecycle_${name.toLowerCase()}`,
                lifecycle === name ? 1 : 0
            );

        }

    }

}

export {
    GovernancePlatformMetricsCollector as GovernanceReadinessMetricsCollector
};
