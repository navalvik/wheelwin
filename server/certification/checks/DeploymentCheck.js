/**
 * R8.0C — Deployment probe readiness.
 */

import { CertificationCheck } from "./CertificationCheck.js";
import { CHECK_STATUS } from "../CertificationStatus.js";

export class DeploymentCheck extends CertificationCheck {

    constructor() {

        super({
            id: "deployment",
            name: "Deployment Probes",
            category: "deployment"
        });

    }

    async run(context) {

        const status = context.providers?.deploymentHealth?.() ?? null;

        if (!status) {

            return {
                status: CHECK_STATUS.WARN,
                details: { available: false },
                recommendations: [
                    "Provide deployment health provider for live probe certification"
                ]
            };

        }

        const details = {
            enabled: status.enabled !== false,
            startup: status.startup === true,
            live: status.live === true,
            ready: status.ready === true,
            overall: status.overall ?? null,
            profile: status.profile ?? null,
            probeFailures: status.probeFailures ?? 0
        };

        const failures = [];

        const warnings = [];

        if (details.enabled === false) {

            failures.push("Health probes disabled");

        }

        if (details.live === false) {

            failures.push("Liveness failed");

        }

        if (details.startup === false) {

            failures.push("Startup probe incomplete");

        }

        if (details.ready === false) {

            // Drain or not running — fail for certification of a live RC host
            failures.push("Readiness not healthy");

        }

        if ((details.probeFailures ?? 0) > 0) {

            warnings.push(`Probe failures recorded: ${details.probeFailures}`);

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
