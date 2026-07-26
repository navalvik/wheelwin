/**
 * R9.0C — Chronological governance audit trail.
 */

export class AuditTrailManager {

    /**
     * @param {{ maxEntries?: number }} [options]
     */
    constructor(options = {}) {

        this._max = options.maxEntries ?? 1000;

        /** @type {object[]} */
        this._entries = [];

    }

    clear() {

        this._entries = [];

    }

    count() {

        return this._entries.length;

    }

    list() {

        return [...this._entries].sort((a, b) => b.timestamp - a.timestamp);

    }

    /**
     * @param {{
     *   type: string,
     *   summary?: string,
     *   details?: object,
     *   refs?: object
     * }} input
     */
    append(input) {

        const entry = Object.freeze({
            id: `trail-${Date.now().toString(36)}-${this._entries.length + 1}`,
            type: String(input.type).slice(0, 64),
            summary: String(input.summary || "").slice(0, 300),
            details: Object.freeze({ ...(input.details ?? {}) }),
            refs: Object.freeze({ ...(input.refs ?? {}) }),
            timestamp: Date.now() + this._entries.length
        });

        this._entries.push(entry);

        if (this._entries.length > this._max) {

            this._entries.splice(0, this._entries.length - this._max);

        }

        return entry;

    }

    summary() {

        const byType = Object.create(null);

        for (const e of this._entries) {

            byType[e.type] = (byType[e.type] ?? 0) + 1;

        }

        return Object.freeze({
            total: this._entries.length,
            byType: Object.freeze({ ...byType })
        });

    }

}
