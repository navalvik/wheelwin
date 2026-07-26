/**
 * R8.0D — Operational incident record.
 */

import {
    INCIDENT_SEVERITY,
    INCIDENT_STATUS
} from "../BetaConfiguration.js";

let _seq = 0;

function nextId() {

    _seq += 1;

    return `beta-i-${Date.now().toString(36)}-${_seq}`;

}

/**
 * @param {{
 *   id?: string,
 *   timestamp?: number,
 *   category?: string,
 *   severity?: string,
 *   status?: string,
 *   affectedVersion?: string|null,
 *   affectedParticipantIds?: string[],
 *   description?: string,
 *   resolution?: string|null,
 *   rootCause?: string|null,
 *   correctiveAction?: string|null
 * }} input
 */
export function createBetaIncident(input = {}) {

    const severityKey = String(input.severity || "MEDIUM").toUpperCase();

    const severity = INCIDENT_SEVERITY[severityKey]
        ?? INCIDENT_SEVERITY.MEDIUM;

    const statusKey = String(input.status || "OPEN").toUpperCase();

    const status = INCIDENT_STATUS[statusKey] ?? INCIDENT_STATUS.OPEN;

    const affected = Array.isArray(input.affectedParticipantIds)
        ? input.affectedParticipantIds
            .map((id) => String(id).slice(0, 64))
            .slice(0, 100)
        : [];

    return Object.freeze({
        id: input.id ? String(input.id) : nextId(),
        timestamp: Number.isFinite(input.timestamp)
            ? input.timestamp
            : Date.now(),
        category: String(input.category || "Operational").slice(0, 64),
        severity,
        status,
        affectedVersion: input.affectedVersion
            ? String(input.affectedVersion).slice(0, 64)
            : null,
        affectedParticipantIds: Object.freeze(affected),
        description: String(input.description || "").slice(0, 4000),
        resolution: input.resolution
            ? String(input.resolution).slice(0, 2000)
            : null,
        rootCause: input.rootCause
            ? String(input.rootCause).slice(0, 2000)
            : null,
        correctiveAction: input.correctiveAction
            ? String(input.correctiveAction).slice(0, 2000)
            : null
    });

}

/**
 * @param {ReturnType<typeof createBetaIncident>} incident
 * @param {object} patch
 */
export function withIncidentPatch(incident, patch) {

    return createBetaIncident({
        ...incident,
        affectedParticipantIds:
            patch.affectedParticipantIds ?? [...incident.affectedParticipantIds],
        ...patch
    });

}

export function resetIncidentIdSequenceForTests() {

    _seq = 0;

}
