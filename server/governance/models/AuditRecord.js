/**
 * R9.0C — Operational audit record.
 */

let _seq = 0;

function nextId() {

    _seq += 1;

    return `audit-${Date.now().toString(36)}-${_seq}`;

}

/**
 * @param {{
 *   id?: string,
 *   domain: string,
 *   status?: string,
 *   timestamp?: number,
 *   durationMs?: number,
 *   details?: object,
 *   recommendations?: string[]
 * }} input
 */
export function createAuditRecord(input) {

    return Object.freeze({
        id: input.id ? String(input.id) : nextId(),
        domain: String(input.domain).slice(0, 64),
        status: String(input.status || "PASS").slice(0, 32),
        timestamp: Number.isFinite(input.timestamp)
            ? input.timestamp
            : Date.now(),
        durationMs: Number.isFinite(input.durationMs) ? input.durationMs : 0,
        details: Object.freeze({ ...(input.details ?? {}) }),
        recommendations: Object.freeze([...(input.recommendations ?? [])])
    });

}

export function resetAuditIdSequenceForTests() {

    _seq = 0;

}
