/**
 * R8.0E — Immutable launch gate result.
 */

import { GATE_STATUS, BLOCKER_SEVERITY } from "../LaunchConfiguration.js";

/**
 * @param {{
 *   id: string,
 *   name: string,
 *   category?: string,
 *   status?: string,
 *   severity?: string,
 *   details?: object,
 *   recommendations?: string[],
 *   durationMs?: number,
 *   timestamp?: number
 * }} input
 */
export function createLaunchGateResult(input) {

    const statusKey = String(input.status || GATE_STATUS.FAIL).toUpperCase();

    const status = GATE_STATUS[statusKey] ?? GATE_STATUS.FAIL;

    const severityKey = String(input.severity || BLOCKER_SEVERITY.MEDIUM)
        .toUpperCase();

    const severity = BLOCKER_SEVERITY[severityKey] ?? BLOCKER_SEVERITY.MEDIUM;

    return Object.freeze({
        id: String(input.id),
        name: String(input.name || input.id),
        category: String(input.category || "general"),
        status,
        severity,
        details: Object.freeze({ ...(input.details ?? {}) }),
        recommendations: Object.freeze([...(input.recommendations ?? [])]),
        durationMs: Number.isFinite(input.durationMs) ? input.durationMs : 0,
        timestamp: Number.isFinite(input.timestamp)
            ? input.timestamp
            : Date.now(),
        passed: status === GATE_STATUS.PASS || status === GATE_STATUS.WARN
    });

}
