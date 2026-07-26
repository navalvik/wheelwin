/**
 * R9.0C — Governance decision record.
 */

import { DECISION_STATUS } from "../GovernanceConfiguration.js";

let _seq = 0;

function nextId() {

    _seq += 1;

    return `gdec-${Date.now().toString(36)}-${_seq}`;

}

/**
 * @param {{
 *   id?: string,
 *   status?: string,
 *   score?: number,
 *   reason?: string,
 *   timestamp?: number,
 *   evidenceHash?: string|null
 * }} input
 */
export function createGovernanceDecision(input = {}) {

    const key = String(input.status || DECISION_STATUS.PENDING).toUpperCase();

    const status = DECISION_STATUS[key] ?? DECISION_STATUS.PENDING;

    return Object.freeze({
        id: input.id ? String(input.id) : nextId(),
        status,
        score: Number.isFinite(input.score) ? input.score : 0,
        reason: String(input.reason || "").slice(0, 500),
        timestamp: Number.isFinite(input.timestamp)
            ? input.timestamp
            : Date.now(),
        evidenceHash: input.evidenceHash
            ? String(input.evidenceHash)
            : null
    });

}

export function resetGovernanceDecisionIdSequenceForTests() {

    _seq = 0;

}
