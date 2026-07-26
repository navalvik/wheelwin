/**
 * R8.0E — Immutable evidence registry for launch gates.
 */

import { createHash } from "node:crypto";

import { createLaunchEvidence } from "./models/LaunchEvidence.js";

export class LaunchEvidenceRegistry {

    constructor() {

        /** @type {Map<string, ReturnType<typeof createLaunchEvidence>>} */
        this._byId = new Map();

        /** @type {ReturnType<typeof createLaunchEvidence>[]} */
        this._order = [];

    }

    clear() {

        this._byId.clear();

        this._order = [];

    }

    count() {

        return this._order.length;

    }

    list() {

        return [...this._order];

    }

    /**
     * @param {Parameters<typeof createLaunchEvidence>[0]} input
     */
    record(input) {

        const evidence = createLaunchEvidence(input);

        this._byId.set(evidence.id, evidence);

        this._order.push(evidence);

        return evidence;

    }

    /**
     * @param {import("./models/LaunchGateResult.js").createLaunchGateResult extends Function
     *   ? ReturnType<import("./models/LaunchGateResult.js").createLaunchGateResult>
     *   : object} gateResult
     */
    recordFromGate(gateResult) {

        return this.record({
            gate: gateResult.id,
            status: gateResult.status,
            timestamp: gateResult.timestamp,
            durationMs: gateResult.durationMs,
            details: {
                name: gateResult.name,
                category: gateResult.category,
                severity: gateResult.severity,
                ...gateResult.details
            },
            recommendations: [...gateResult.recommendations]
        });

    }

    /**
     * Aggregate hash over all evidence (deterministic order).
     */
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
