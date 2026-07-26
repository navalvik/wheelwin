/**
 * R9.0B — Escalation record.
 */

import {
    ESCALATION_LEVEL,
    INCIDENT_SEVERITY
} from "../OperationsConfiguration.js";

let _seq = 0;

function nextId() {

    _seq += 1;

    return `esc-${Date.now().toString(36)}-${_seq}`;

}

/**
 * @param {{
 *   id?: string,
 *   incidentId?: string,
 *   level?: string,
 *   severity?: string,
 *   timestamp?: number,
 *   notes?: string|null
 * }} input
 */
export function createEscalationRecord(input = {}) {

    const levelKey = String(input.level || ESCALATION_LEVEL.LEVEL_1)
        .toUpperCase();

    const level = ESCALATION_LEVEL[levelKey] ?? ESCALATION_LEVEL.LEVEL_1;

    const severityKey = String(input.severity || INCIDENT_SEVERITY.MEDIUM)
        .toUpperCase();

    const severity = INCIDENT_SEVERITY[severityKey]
        ?? INCIDENT_SEVERITY.MEDIUM;

    return Object.freeze({
        id: input.id ? String(input.id) : nextId(),
        incidentId: input.incidentId
            ? String(input.incidentId).slice(0, 64)
            : null,
        level,
        severity,
        timestamp: Number.isFinite(input.timestamp)
            ? input.timestamp
            : Date.now(),
        notes: input.notes ? String(input.notes).slice(0, 500) : null
    });

}

export function resetEscalationIdSequenceForTests() {

    _seq = 0;

}
