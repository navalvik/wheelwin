/**
 * R8.0C — Configuration profile / version consistency.
 */

import { CertificationCheck } from "./CertificationCheck.js";
import { CHECK_STATUS } from "../CertificationStatus.js";

export class ConfigurationCheck extends CertificationCheck {

    constructor() {

        super({
            id: "configuration",
            name: "Configuration Consistency",
            category: "configuration"
        });

    }

    async run(context) {

        const manifest = context.manifest;

        const config = context.productionConfig ?? {};

        const expectedVersion = context.expectedVersion ?? null;

        const expectedCommit = context.expectedCommit ?? null;

        const profile = config.deployment?.profile
            ?? context.profile
            ?? null;

        const channel = config.release?.channel
            ?? manifest?.channel
            ?? null;

        const details = {
            profile,
            channel,
            manifestVersion: manifest?.version ?? null,
            expectedVersion,
            manifestCommit: manifest?.build?.commit ?? null,
            expectedCommit,
            failurePolicyEnabled: config.failurePolicy?.enabled !== false,
            monitoringEnabled: config.monitoring?.enabled !== false,
            healthEnabled: config.deployment?.healthEnabled !== false
        };

        const failures = [];

        const warnings = [];

        if (!manifest) {

            failures.push("Missing release manifest in context");

        }

        if (expectedVersion && manifest?.version
            && expectedVersion !== manifest.version) {

            failures.push("Version mismatch between expected and manifest");

        }

        if (expectedCommit
            && expectedCommit !== "unknown"
            && manifest?.build?.commit
            && manifest.build.commit !== "unknown"
            && expectedCommit !== manifest.build.commit) {

            failures.push("Git commit mismatch between expected and manifest");

        }

        if (profile === "production" && channel === "development") {

            warnings.push("Production profile with development release channel");

        }

        if (config.failurePolicy?.enabled === false && profile === "production") {

            failures.push("Failure policy disabled on production profile");

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
