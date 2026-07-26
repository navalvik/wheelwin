/**
 * R9.0A — Immutable production evidence registry.
 */

import { createHash } from "node:crypto";

import { createProductionEvidence } from "./models/ProductionEvidence.js";

export class ProductionEvidenceRegistry {

    constructor() {

        /** @type {ReturnType<typeof createProductionEvidence>[]} */
        this._order = [];

        /** @type {Map<string, ReturnType<typeof createProductionEvidence>>} */
        this._byId = new Map();

    }

    clear() {

        this._order = [];

        this._byId.clear();

    }

    count() {

        return this._order.length;

    }

    list() {

        return [...this._order];

    }

    /**
     * @param {Parameters<typeof createProductionEvidence>[0]} input
     */
    record(input) {

        const evidence = createProductionEvidence(input);

        this._byId.set(evidence.id, evidence);

        this._order.push(evidence);

        return evidence;

    }

    /**
     * @param {{
     *   id: string,
     *   name?: string,
     *   status: string,
     *   durationMs?: number,
     *   details?: object,
     *   recommendations?: string[],
     *   timestamp?: number
     * }} check
     */
    recordFromCheck(check) {

        return this.record({
            verification: check.id,
            status: check.status,
            timestamp: check.timestamp,
            durationMs: check.durationMs,
            details: {
                name: check.name ?? check.id,
                ...(check.details ?? {})
            },
            recommendations: [...(check.recommendations ?? [])]
        });

    }

    getAggregateHash() {

        const payload = this._order.map((e) => e.evidenceHash).join("|");

        return createHash("sha256").update(payload).digest("hex");

    }

    summary() {

        const byStatus = Object.create(null);

        for (const e of this._order) {

            byStatus[e.status] = (byStatus[e.status] ?? 0) + 1;

        }

        return Object.freeze({
            total: this._order.length,
            byStatus: Object.freeze({ ...byStatus }),
            aggregateHash: this.getAggregateHash()
        });

    }

}
