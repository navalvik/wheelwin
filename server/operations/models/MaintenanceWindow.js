/**
 * R9.0B — Maintenance window record.
 */

import {
    MAINTENANCE_TYPE,
    MAINTENANCE_OUTCOME
} from "../OperationsConfiguration.js";

let _seq = 0;

function nextId() {

    _seq += 1;

    return `mw-${Date.now().toString(36)}-${_seq}`;

}

/**
 * @param {{
 *   id?: string,
 *   type?: string,
 *   start?: number,
 *   end?: number|null,
 *   durationMs?: number|null,
 *   reason?: string,
 *   verification?: string|null,
 *   outcome?: string
 * }} input
 */
export function createMaintenanceWindow(input = {}) {

    const typeKey = String(input.type || MAINTENANCE_TYPE.SCHEDULED)
        .toUpperCase();

    const type = MAINTENANCE_TYPE[typeKey] ?? MAINTENANCE_TYPE.SCHEDULED;

    const outcomeKey = String(input.outcome || MAINTENANCE_OUTCOME.PENDING)
        .toUpperCase();

    const outcome = MAINTENANCE_OUTCOME[outcomeKey]
        ?? MAINTENANCE_OUTCOME.PENDING;

    const start = Number.isFinite(input.start) ? input.start : Date.now();

    const end = Number.isFinite(input.end) ? input.end : null;

    const durationMs = Number.isFinite(input.durationMs)
        ? input.durationMs
        : (end != null ? Math.max(0, end - start) : null);

    return Object.freeze({
        id: input.id ? String(input.id) : nextId(),
        type,
        start,
        end,
        durationMs,
        reason: String(input.reason || "Maintenance").slice(0, 500),
        verification: input.verification
            ? String(input.verification).slice(0, 500)
            : null,
        outcome
    });

}

/**
 * @param {ReturnType<typeof createMaintenanceWindow>} window
 * @param {object} patch
 */
export function withMaintenanceWindowPatch(window, patch) {

    return createMaintenanceWindow({
        ...window,
        ...patch
    });

}

export function resetMaintenanceIdSequenceForTests() {

    _seq = 0;

}
