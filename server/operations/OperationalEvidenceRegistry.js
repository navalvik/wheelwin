/**
 * R9.0B — Immutable operational evidence registry.
 */

import { createHash } from "node:crypto";

import { createOperationalEvidence } from "./models/OperationalEvidence.js";

export class OperationalEvidenceRegistry {

    /**
     * @param {{ maxEvidence?: number }} [options]
     */
    constructor(options = {}) {

        this._max = options.maxEvidence ?? 200;

        /** @type {ReturnType<typeof createOperationalEvidence>[]} */
        this._order = [];

    }

    clear() {

        this._order = [];

    }

    count() {

        return this._order.length;

    }

    list() {

        return [...this._order];

    }

    /**
     * @param {Parameters<typeof createOperationalEvidence>[0]} input
     */
    record(input) {

        const evidence = createOperationalEvidence(input);

        this._order.push(evidence);

        if (this._order.length > this._max) {

            this._order.splice(0, this._order.length - this._max);

        }

        return evidence;

    }

    getAggregateHash() {

        return createHash("sha256")
            .update(this._order.map((e) => e.evidenceHash).join("|"))
            .digest("hex");

    }

    summary() {

        return Object.freeze({
            total: this._order.length,
            aggregateHash: this.getAggregateHash()
        });

    }

}
