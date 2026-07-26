/**
 * R9.0B — Operational incident record.
 */

import { INCIDENT_SEVERITY } from "../OperationsConfiguration.js";

let _seq = 0;

function nextId() {

    _seq += 1;

    return `oi-${Date.now().toString(36)}-${_seq}`;

}

/**
 * @param {{
 *   id?: string,
 *   timestamp?: number,
 *   severity?: string,
 *   category?: string,
 *   summary?: string,
 *   description?: string,
 *   open?: boolean,
 *   version?: string|null
 * }} input
 */
export function createOperationalIncident(input = {}) {

    const severityKey = String(input.severity || INCIDENT_SEVERITY.MEDIUM)
        .toUpperCase();

    const severity = INCIDENT_SEVERITY[severityKey]
        ?? INCIDENT_SEVERITY.MEDIUM;

    return Object.freeze({
        id: input.id ? String(input.id) : nextId(),
        timestamp: Number.isFinite(input.timestamp)
            ? input.timestamp
            : Date.now(),
        severity,
        category: String(input.category || "Operational").slice(0, 64),
        summary: String(input.summary || "Untitled").slice(0, 200),
        description: String(input.description || "").slice(0, 4000),
        open: input.open !== false,
        version: input.version ? String(input.version).slice(0, 64) : null
    });

}

/**
 * @param {ReturnType<typeof createOperationalIncident>} incident
 * @param {object} patch
 */
export function withOperationalIncidentPatch(incident, patch) {

    return createOperationalIncident({
        ...incident,
        ...patch
    });

}

export function resetOperationalIncidentIdSequenceForTests() {

    _seq = 0;

}
