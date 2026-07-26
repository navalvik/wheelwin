/**
 * R8.0D — Structured feedback collection.
 */

import {
    createBetaFeedback,
    withFeedbackPatch
} from "./models/BetaFeedback.js";
import { FEEDBACK_STATUS } from "./BetaConfiguration.js";

export class BetaFeedbackManager {

    /**
     * @param {{ maxFeedback?: number }} [options]
     */
    constructor(options = {}) {

        this._max = options.maxFeedback ?? 500;

        /** @type {Map<string, ReturnType<typeof createBetaFeedback>>} */
        this._items = new Map();

    }

    clear() {

        this._items.clear();

    }

    count() {

        return this._items.size;

    }

    list() {

        return [...this._items.values()]
            .sort((a, b) => b.timestamp - a.timestamp);

    }

    get(id) {

        return this._items.get(id) ?? null;

    }

    /**
     * @param {Parameters<typeof createBetaFeedback>[0]} input
     */
    submit(input) {

        if (this._items.size >= this._max) {

            throw new Error("Closed Beta feedback capacity reached");

        }

        const item = createBetaFeedback(input);

        this._items.set(item.id, item);

        return item;

    }

    setStatus(id, status) {

        const existing = this._items.get(id);

        if (!existing) {

            throw new Error("Unknown feedback");

        }

        const key = String(status).toUpperCase();

        if (!FEEDBACK_STATUS[key]) {

            throw new Error("Invalid feedback status");

        }

        const updated = withFeedbackPatch(existing, { status: key });

        this._items.set(id, updated);

        return updated;

    }

    summary() {

        const byStatus = Object.create(null);

        const byCategory = Object.create(null);

        const bySeverity = Object.create(null);

        for (const key of Object.values(FEEDBACK_STATUS)) {

            byStatus[key] = 0;

        }

        for (const item of this._items.values()) {

            byStatus[item.status] = (byStatus[item.status] ?? 0) + 1;

            byCategory[item.category] = (byCategory[item.category] ?? 0) + 1;

            bySeverity[item.severity] = (bySeverity[item.severity] ?? 0) + 1;

        }

        return Object.freeze({
            total: this._items.size,
            byStatus: Object.freeze({ ...byStatus }),
            byCategory: Object.freeze({ ...byCategory }),
            bySeverity: Object.freeze({ ...bySeverity }),
            criticalOpen:
                (bySeverity.CRITICAL ?? 0) > 0
                && (byStatus.OPEN ?? 0) + (byStatus.INVESTIGATING ?? 0) > 0
                    ? (bySeverity.CRITICAL ?? 0)
                    : (bySeverity.CRITICAL ?? 0)
                        * ((byStatus.OPEN ?? 0) > 0
                            || (byStatus.INVESTIGATING ?? 0) > 0 ? 1 : 0)
        });

    }

    /**
     * Count open/investigating feedback at CRITICAL or HIGH.
     */
    openHighSeverityCount() {

        let n = 0;

        for (const item of this._items.values()) {

            if (
                (item.status === FEEDBACK_STATUS.OPEN
                    || item.status === FEEDBACK_STATUS.ACKNOWLEDGED
                    || item.status === FEEDBACK_STATUS.INVESTIGATING)
                && (item.severity === "CRITICAL" || item.severity === "HIGH")
            ) {

                n += 1;

            }

        }

        return n;

    }

}
