/**
 * R8.0C — Sequential certification check runner.
 */

import {
    CERTIFICATION_STATUS,
    CHECK_STATUS
} from "./CertificationStatus.js";

export class CertificationRunner {

    /**
     * @param {{
     *   checklist: import("./CertificationChecklist.js").CertificationChecklist,
     *   onCheckComplete?: (evidence: object) => void
     * }} options
     */
    constructor({ checklist, onCheckComplete = null }) {

        this._checklist = checklist;

        this._onCheckComplete = onCheckComplete;

    }

    /**
     * @param {object} context
     */
    async run(context) {

        const evidence = [];

        const started = performance.now();

        for (const check of this._checklist.getChecks()) {

            const record = await check.execute(context);

            evidence.push(record);

            this._onCheckComplete?.(record.toJSON());

        }

        const durationMs = Number((performance.now() - started).toFixed(3));

        const failed = evidence.filter((e) => e.status === CHECK_STATUS.FAIL);

        const warned = evidence.filter((e) => e.status === CHECK_STATUS.WARN);

        let status;

        if (failed.length > 0) {

            status = CERTIFICATION_STATUS.FAILED;

        } else if (warned.length > 0) {

            status = CERTIFICATION_STATUS.PASSED_WITH_WARNINGS;

        } else {

            status = CERTIFICATION_STATUS.PASSED;

        }

        return {
            status,
            durationMs,
            evidence,
            summary: {
                total: evidence.length,
                passed: evidence.filter((e) => e.status === CHECK_STATUS.PASS).length,
                warnings: warned.length,
                failures: failed.length
            }
        };

    }

}
