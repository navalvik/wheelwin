/**
 * R9.0A — Rollback recommendation decision.
 */

import { ROLLBACK_SEVERITY } from "../ProductionConfiguration.js";

/**
 * @param {{
 *   recommend?: boolean,
 *   severity?: string|null,
 *   triggers?: object[],
 *   reason?: string,
 *   evaluatedAt?: number
 * }} input
 */
export function createRollbackDecision(input = {}) {

    const severityKey = input.severity
        ? String(input.severity).toUpperCase()
        : null;

    const severity = severityKey && ROLLBACK_SEVERITY[severityKey]
        ? severityKey
        : null;

    return Object.freeze({
        recommend: input.recommend === true,
        severity,
        triggers: Object.freeze(
            (input.triggers ?? []).map((t) => Object.freeze({ ...t }))
        ),
        reason: String(input.reason || "").slice(0, 500),
        evaluatedAt: Number.isFinite(input.evaluatedAt)
            ? input.evaluatedAt
            : Date.now()
    });

}
