/**
 * R8.0C — Base certification check (read-only).
 */

import { CertificationEvidence } from "../CertificationEvidence.js";
import { CHECK_STATUS } from "../CertificationStatus.js";

export class CertificationCheck {

    /**
     * @param {{ id: string, name: string, category: string }} options
     */
    constructor({ id, name, category }) {

        this.id = id;

        this.name = name;

        this.category = category;

    }

    /**
     * @param {object} context
     * @returns {Promise<{
     *   status: string,
     *   details?: object,
     *   recommendations?: string[]
     * }>}
     */
    async run(_context) {

        throw new Error(`Check ${this.id} must implement run()`);

    }

    /**
     * @param {object} context
     * @returns {Promise<CertificationEvidence>}
     */
    async execute(context) {

        const started = performance.now();

        let result;

        try {

            result = await this.run(context);

        } catch (error) {

            result = {
                status: CHECK_STATUS.FAIL,
                details: { error: error?.message ?? String(error) },
                recommendations: ["Fix check runtime error and re-run certification"]
            };

        }

        return new CertificationEvidence({
            id: this.id,
            name: this.name,
            category: this.category,
            status: result.status ?? CHECK_STATUS.FAIL,
            timestamp: Date.now(),
            durationMs: Number((performance.now() - started).toFixed(3)),
            details: result.details ?? {},
            recommendations: result.recommendations ?? []
        });

    }

}
