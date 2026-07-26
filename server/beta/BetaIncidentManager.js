/**
 * R8.0D — Operational incident tracking.
 */

import {
    createBetaIncident,
    withIncidentPatch
} from "./models/BetaIncident.js";
import { INCIDENT_SEVERITY, INCIDENT_STATUS } from "./BetaConfiguration.js";

export class BetaIncidentManager {

    /**
     * @param {{ maxIncidents?: number }} [options]
     */
    constructor(options = {}) {

        this._max = options.maxIncidents ?? 200;

        /** @type {Map<string, ReturnType<typeof createBetaIncident>>} */
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
     * @param {Parameters<typeof createBetaIncident>[0]} input
     */
    report(input) {

        if (this._items.size >= this._max) {

            throw new Error("Closed Beta incident capacity reached");

        }

        const item = createBetaIncident(input);

        this._items.set(item.id, item);

        return item;

    }

    update(id, patch) {

        const existing = this._items.get(id);

        if (!existing) {

            throw new Error("Unknown incident");

        }

        if (patch.status) {

            const key = String(patch.status).toUpperCase();

            if (!INCIDENT_STATUS[key]) {

                throw new Error("Invalid incident status");

            }

            patch = { ...patch, status: key };

        }

        if (patch.severity) {

            const key = String(patch.severity).toUpperCase();

            if (!INCIDENT_SEVERITY[key]) {

                throw new Error("Invalid incident severity");

            }

            patch = { ...patch, severity: key };

        }

        const updated = withIncidentPatch(existing, patch);

        this._items.set(id, updated);

        return updated;

    }

    resolve(id, { resolution, rootCause, correctiveAction } = {}) {

        return this.update(id, {
            status: INCIDENT_STATUS.RESOLVED,
            resolution,
            rootCause,
            correctiveAction
        });

    }

    summary() {

        const bySeverity = Object.create(null);

        const byStatus = Object.create(null);

        for (const s of Object.values(INCIDENT_SEVERITY)) {

            bySeverity[s] = 0;

        }

        for (const s of Object.values(INCIDENT_STATUS)) {

            byStatus[s] = 0;

        }

        let openCritical = 0;

        for (const item of this._items.values()) {

            bySeverity[item.severity] = (bySeverity[item.severity] ?? 0) + 1;

            byStatus[item.status] = (byStatus[item.status] ?? 0) + 1;

            if (
                item.severity === INCIDENT_SEVERITY.CRITICAL
                && item.status !== INCIDENT_STATUS.RESOLVED
                && item.status !== INCIDENT_STATUS.WONT_FIX
            ) {

                openCritical += 1;

            }

        }

        return Object.freeze({
            total: this._items.size,
            bySeverity: Object.freeze({ ...bySeverity }),
            byStatus: Object.freeze({ ...byStatus }),
            openCritical
        });

    }

    openCriticalCount() {

        return this.summary().openCritical;

    }

}
