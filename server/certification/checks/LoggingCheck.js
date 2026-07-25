/**
 * R8.0C — Logging / audit / redaction readiness.
 */

import { CertificationCheck } from "./CertificationCheck.js";
import { CHECK_STATUS } from "../CertificationStatus.js";

export class LoggingCheck extends CertificationCheck {

    constructor() {

        super({
            id: "logging",
            name: "Logging & Audit",
            category: "logging"
        });

    }

    async run(context) {

        const status = context.providers?.logging?.() ?? null;

        if (!status) {

            return {
                status: CHECK_STATUS.WARN,
                details: { available: false },
                recommendations: [
                    "Provide logging provider during live certification"
                ]
            };

        }

        const serialized = JSON.stringify(status);

        const details = {
            status: status.status ?? null,
            level: status.level ?? null,
            fileEnabled: status.fileEnabled === true,
            rotationStatus: status.rotationStatus ?? null,
            hasAbsolutePath: /[A-Za-z]:[\\/]|\/home\/|\/Users\//.test(serialized)
        };

        const failures = [];

        const warnings = [];

        if (status.status && status.status !== "ok") {

            failures.push(`Logger status is ${status.status}`);

        }

        if (details.hasAbsolutePath) {

            failures.push("Logger safe status exposes absolute filesystem paths");

        }

        if (/password|mnemonic|private[_-]?key/i.test(serialized)) {

            failures.push("Possible secret material in logger status");

        }

        if (!status.rotationStatus && status.fileEnabled) {

            warnings.push("File logging enabled without rotation status");

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
