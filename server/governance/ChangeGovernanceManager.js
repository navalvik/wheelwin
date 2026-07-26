/**
 * R9.0C — Observational change governance log (no runtime mutation).
 */

import { CHANGE_STATUS } from "./GovernanceConfiguration.js";

let _seq = 0;

function nextId() {

    _seq += 1;

    return `chg-${Date.now().toString(36)}-${_seq}`;

}

export class ChangeGovernanceManager {

    /**
     * @param {{ maxChanges?: number }} [options]
     */
    constructor(options = {}) {

        this._max = options.maxChanges ?? 500;

        /** @type {object[]} */
        this._changes = [];

    }

    clear() {

        this._changes = [];

    }

    list() {

        return [...this._changes].sort((a, b) => b.timestamp - a.timestamp);

    }

    /**
     * @param {{
     *   title?: string,
     *   category?: string,
     *   description?: string,
     *   status?: string
     * }} input
     */
    propose(input = {}) {

        if (this._changes.length >= this._max) {

            throw new Error("Change governance capacity reached");

        }

        const statusKey = String(input.status || CHANGE_STATUS.PROPOSED)
            .toUpperCase();

        const status = CHANGE_STATUS[statusKey] ?? CHANGE_STATUS.PROPOSED;

        const record = Object.freeze({
            id: nextId(),
            title: String(input.title || "Change").slice(0, 200),
            category: String(input.category || "general").slice(0, 64),
            description: String(input.description || "").slice(0, 1000),
            status,
            timestamp: Date.now() + this._changes.length
        });

        this._changes.push(record);

        return record;

    }

    /**
     * @param {string} id
     * @param {string} status
     */
    setStatus(id, status) {

        const idx = this._changes.findIndex((c) => c.id === id);

        if (idx < 0) {

            throw new Error("Unknown change record");

        }

        const key = String(status).toUpperCase();

        if (!CHANGE_STATUS[key]) {

            throw new Error("Invalid change status");

        }

        const updated = Object.freeze({
            ...this._changes[idx],
            status: key,
            timestamp: Date.now() + this._changes.length
        });

        this._changes[idx] = updated;

        return updated;

    }

    summary() {

        const byStatus = Object.create(null);

        for (const s of Object.values(CHANGE_STATUS)) {

            byStatus[s] = 0;

        }

        for (const c of this._changes) {

            byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;

        }

        return Object.freeze({
            total: this._changes.length,
            byStatus: Object.freeze({ ...byStatus })
        });

    }

}

export function resetChangeIdSequenceForTests() {

    _seq = 0;

}
