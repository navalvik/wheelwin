/**
 * R8.0C — Immutable evidence record for a single check.
 */

import { CHECK_STATUS } from "./CertificationStatus.js";

export class CertificationEvidence {

    /**
     * @param {{
     *   id: string,
     *   name: string,
     *   category: string,
     *   status: string,
     *   timestamp?: number,
     *   durationMs?: number,
     *   details?: object,
     *   recommendations?: string[]
     * }} input
     */
    constructor(input) {

        this.id = input.id;

        this.name = input.name;

        this.category = input.category;

        this.status = input.status ?? CHECK_STATUS.FAIL;

        this.timestamp = input.timestamp ?? Date.now();

        this.durationMs = Number.isFinite(input.durationMs)
            ? Number(input.durationMs)
            : 0;

        this.details = Object.freeze({ ...(input.details ?? {}) });

        this.recommendations = Object.freeze(
            [...(input.recommendations ?? [])]
        );

        Object.freeze(this);

    }

    toJSON() {

        return {
            id: this.id,
            name: this.name,
            category: this.category,
            status: this.status,
            timestamp: this.timestamp,
            durationMs: this.durationMs,
            details: { ...this.details },
            recommendations: [...this.recommendations]
        };

    }

}
