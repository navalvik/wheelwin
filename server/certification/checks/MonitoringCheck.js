/**
 * R8.0C — Monitoring freshness / overhead.
 */

import { CertificationCheck } from "./CertificationCheck.js";
import { CHECK_STATUS } from "../CertificationStatus.js";

export class MonitoringCheck extends CertificationCheck {

    constructor() {

        super({
            id: "monitoring",
            name: "Monitoring Health",
            category: "monitoring"
        });

    }

    async run(context) {

        const status = context.providers?.monitoring?.() ?? null;

        const snapshot = context.providers?.monitoringSnapshot?.() ?? null;

        if (!status && !snapshot) {

            return {
                status: CHECK_STATUS.WARN,
                details: { available: false },
                recommendations: [
                    "Provide monitoring provider during live certification"
                ]
            };

        }

        const freshnessMs = status?.freshnessMs
            ?? (snapshot?.collectedAt
                ? Math.max(0, Date.now() - snapshot.collectedAt)
                : null);

        const details = {
            enabled: status?.enabled !== false,
            running: status?.running === true || snapshot?.enabled === true,
            freshnessMs,
            collectorCount: status?.collectorCount ?? null,
            eventLoopDelayMs: snapshot?.runtime?.eventLoopDelayMs ?? null,
            memoryRss: snapshot?.runtime?.memoryRssBytes ?? null
        };

        const failures = [];

        const warnings = [];

        if (details.enabled === false) {

            failures.push("Monitoring disabled");

        }

        if (freshnessMs != null && freshnessMs > 30_000) {

            warnings.push("Metrics freshness exceeds 30s");

        }

        if (details.eventLoopDelayMs != null && details.eventLoopDelayMs > 100) {

            warnings.push("Event loop delay elevated");

        }

        if (failures.length) {

            return {
                status: CHECK_STATUS.FAIL,
                details: { ...details, failures },
                recommendations: failures
            };

        }

        return {
            status: warnings.length ? CHECK_STATUS.WARN : CHECK_STATUS.PASS,
            details: { ...details, warnings },
            recommendations: warnings
        };

    }

}
