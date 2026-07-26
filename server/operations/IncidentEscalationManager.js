/**
 * R9.0B — Observational incident escalation.
 */

import {
    INCIDENT_SEVERITY,
    ESCALATION_LEVEL
} from "./OperationsConfiguration.js";
import {
    createOperationalIncident,
    withOperationalIncidentPatch
} from "./models/OperationalIncident.js";
import { createEscalationRecord } from "./models/EscalationRecord.js";

const SEVERITY_TO_LEVEL = Object.freeze({
    [INCIDENT_SEVERITY.LOW]: ESCALATION_LEVEL.LEVEL_1,
    [INCIDENT_SEVERITY.MEDIUM]: ESCALATION_LEVEL.LEVEL_1,
    [INCIDENT_SEVERITY.HIGH]: ESCALATION_LEVEL.LEVEL_2,
    [INCIDENT_SEVERITY.CRITICAL]: ESCALATION_LEVEL.LEVEL_3
});

const LEVEL_ORDER = Object.freeze([
    ESCALATION_LEVEL.LEVEL_1,
    ESCALATION_LEVEL.LEVEL_2,
    ESCALATION_LEVEL.LEVEL_3,
    ESCALATION_LEVEL.ROOT_CAUSE_ANALYSIS
]);

export class IncidentEscalationManager {

    /**
     * @param {{ maxIncidents?: number }} [options]
     */
    constructor(options = {}) {

        this._max = options.maxIncidents ?? 500;

        /** @type {Map<string, ReturnType<typeof createOperationalIncident>>} */
        this._incidents = new Map();

        /** @type {ReturnType<typeof createEscalationRecord>[]} */
        this._escalations = [];

    }

    clear() {

        this._incidents.clear();

        this._escalations = [];

    }

    listIncidents() {

        return [...this._incidents.values()]
            .sort((a, b) => b.timestamp - a.timestamp);

    }

    listEscalations() {

        return [...this._escalations]
            .sort((a, b) => b.timestamp - a.timestamp);

    }

    /**
     * @param {Parameters<typeof createOperationalIncident>[0]} input
     * @param {{ autoEscalate?: boolean }} [opts]
     */
    report(input, opts = {}) {

        if (this._incidents.size >= this._max) {

            throw new Error("Operational incident capacity reached");

        }

        const incident = createOperationalIncident(input);

        this._incidents.set(incident.id, incident);

        if (opts.autoEscalate !== false) {

            this.escalate(incident.id);

        }

        return incident;

    }

    resolve(incidentId) {

        const existing = this._incidents.get(incidentId);

        if (!existing) {

            throw new Error("Unknown incident");

        }

        const updated = withOperationalIncidentPatch(existing, {
            open: false
        });

        this._incidents.set(incidentId, updated);

        return updated;

    }

    /**
     * @param {string} incidentId
     * @param {{ level?: string, notes?: string }} [opts]
     */
    escalate(incidentId, opts = {}) {

        const incident = this._incidents.get(incidentId);

        if (!incident) {

            throw new Error("Unknown incident");

        }

        const existingForIncident = this._escalations
            .filter((e) => e.incidentId === incidentId);

        let level = opts.level
            ? (ESCALATION_LEVEL[String(opts.level).toUpperCase()]
                ?? SEVERITY_TO_LEVEL[incident.severity])
            : SEVERITY_TO_LEVEL[incident.severity];

        if (!opts.level && existingForIncident.length > 0) {

            const last = existingForIncident[existingForIncident.length - 1];

            const idx = LEVEL_ORDER.indexOf(last.level);

            level = LEVEL_ORDER[Math.min(idx + 1, LEVEL_ORDER.length - 1)];

        }

        const record = createEscalationRecord({
            incidentId,
            level,
            severity: incident.severity,
            notes: opts.notes ?? incident.summary,
            // Ensure stable ordering when escalations occur in the same ms
            timestamp: Date.now() + this._escalations.length
        });

        this._escalations.push(record);

        return record;

    }

    requestRca(incidentId, notes = null) {

        return this.escalate(incidentId, {
            level: ESCALATION_LEVEL.ROOT_CAUSE_ANALYSIS,
            notes: notes ?? "Root cause analysis requested"
        });

    }

    summary() {

        const bySeverity = Object.create(null);

        const byLevel = Object.create(null);

        for (const s of Object.values(INCIDENT_SEVERITY)) {

            bySeverity[s] = 0;

        }

        for (const l of Object.values(ESCALATION_LEVEL)) {

            byLevel[l] = 0;

        }

        let open = 0;

        let openCritical = 0;

        for (const i of this._incidents.values()) {

            bySeverity[i.severity] = (bySeverity[i.severity] ?? 0) + 1;

            if (i.open) {

                open += 1;

                if (i.severity === INCIDENT_SEVERITY.CRITICAL) {

                    openCritical += 1;

                }

            }

        }

        for (const e of this._escalations) {

            byLevel[e.level] = (byLevel[e.level] ?? 0) + 1;

        }

        return Object.freeze({
            total: this._incidents.size,
            open,
            openCritical,
            escalations: this._escalations.length,
            bySeverity: Object.freeze({ ...bySeverity }),
            byLevel: Object.freeze({ ...byLevel })
        });

    }

}
