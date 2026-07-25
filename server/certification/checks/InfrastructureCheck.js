/**
 * R8.0C — Infrastructure subsystem enablement.
 */

import { CertificationCheck } from "./CertificationCheck.js";
import { CHECK_STATUS } from "../CertificationStatus.js";

export class InfrastructureCheck extends CertificationCheck {

    constructor() {

        super({
            id: "infrastructure",
            name: "Infrastructure Readiness",
            category: "infrastructure"
        });

    }

    async run(context) {

        const providers = context.providers ?? {};

        const logging = providers.logging?.() ?? null;

        const monitoring = providers.monitoring?.() ?? null;

        const failure = providers.failurePolicy?.() ?? null;

        const deployment = providers.deploymentHealth?.() ?? null;

        const consoleOk = providers.developerConsole?.() ?? null;

        const details = {
            loggingActive: logging?.initialized === true
                || logging?.status === "ok"
                || logging === true,
            monitoringActive: monitoring?.enabled === true
                || monitoring?.running === true
                || monitoring === true,
            failurePolicyEnabled: failure?.enabled === true || failure === true,
            healthEnabled: deployment?.enabled !== false,
            developerConsole: consoleOk === true || consoleOk?.enabled === true
        };

        // When providers absent (offline cert of package only), WARN not FAIL
        const offline = !providers.logging
            && !providers.monitoring
            && !providers.failurePolicy;

        if (offline) {

            const cfg = context.productionConfig ?? {};

            details.loggingActive = true;

            details.monitoringActive = cfg.monitoring?.enabled !== false;

            details.failurePolicyEnabled = cfg.failurePolicy?.enabled !== false;

            details.healthEnabled = cfg.deployment?.healthEnabled !== false;

            details.developerConsole = true;

            details.mode = "config-offline";

            return {
                status: CHECK_STATUS.WARN,
                details,
                recommendations: [
                    "Re-run certification with live providers for full infrastructure proof"
                ]
            };

        }

        const failures = [];

        if (!details.loggingActive) {

            failures.push("Logging not active");

        }

        if (!details.monitoringActive) {

            failures.push("Monitoring not active");

        }

        if (!details.failurePolicyEnabled) {

            failures.push("Failure policy not enabled");

        }

        if (details.healthEnabled === false) {

            failures.push("Health/deployment probes disabled");

        }

        if (failures.length) {

            return {
                status: CHECK_STATUS.FAIL,
                details: { ...details, failures },
                recommendations: failures
            };

        }

        return {
            status: CHECK_STATUS.PASS,
            details
        };

    }

}
