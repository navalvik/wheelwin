/**
 * R8.0C — Security posture checks (read-only).
 */

import { CertificationCheck } from "./CertificationCheck.js";
import { CHECK_STATUS } from "../CertificationStatus.js";

export class SecurityCheck extends CertificationCheck {

    constructor() {

        super({
            id: "security",
            name: "Security Posture",
            category: "security"
        });

    }

    async run(context) {

        const safe = context.safeConfiguration ?? null;

        const developer = context.runtimeConfig?.developer
            ?? safe?.developerConsole
            ?? null;

        const profile = context.productionConfig?.deployment?.profile
            ?? context.profile
            ?? "development";

        const healthSnap = context.providers?.healthSnapshot?.() ?? null;

        const surfaces = [
            safe,
            healthSnap,
            context.providers?.logging?.(),
            context.providers?.failurePolicy?.(),
            context.manifest
        ];

        const serialized = JSON.stringify(surfaces);

        const details = {
            profile,
            authEnabled: developer?.authEnabled === true
                || developer?.enabled === true,
            authConfigured: developer?.authConfigured === true
                || developer?.configured === true,
            secretsInSurfaces: /password|mnemonic|private[_-]?key|Bearer\s+[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/i
                .test(serialized),
            debugSimulation: context.productionConfig?.debugSimulationLoop === true,
            runStartupDemonstrations:
                context.productionConfig?.runStartupDemonstrations === true
        };

        const failures = [];

        const warnings = [];

        if (details.secretsInSurfaces) {

            failures.push("Secret-like material detected in certification surfaces");

        }

        if (profile === "production" || profile === "staging") {

            if (details.authEnabled === false) {

                failures.push("Developer auth must remain enabled in staging/production");

            }

            if (details.debugSimulation) {

                failures.push("DEBUG_SIMULATION_LOOP must be off in staging/production");

            }

            if (details.runStartupDemonstrations) {

                failures.push("Startup demonstrations forbidden in staging/production");

            }

        }

        if (profile === "development") {

            warnings.push("Development profile — security gates relaxed");

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
