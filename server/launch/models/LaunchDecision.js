/**
 * R8.0E — Immutable launch decision record.
 */

import { LAUNCH_DECISION } from "../LaunchConfiguration.js";

/**
 * @param {{
 *   decision?: string,
 *   score?: number,
 *   reason?: string,
 *   blockers?: object[],
 *   openBetaReady?: boolean,
 *   gaReady?: boolean,
 *   productionReady?: boolean,
 *   evaluatedAt?: number,
 *   evidenceHash?: string|null
 * }} input
 */
export function createLaunchDecision(input = {}) {

    const key = String(input.decision || LAUNCH_DECISION.NOT_READY)
        .toUpperCase();

    const decision = LAUNCH_DECISION[key] ?? LAUNCH_DECISION.NOT_READY;

    return Object.freeze({
        decision,
        score: Number.isFinite(input.score) ? input.score : 0,
        reason: String(input.reason || "").slice(0, 500),
        blockers: Object.freeze(
            (input.blockers ?? []).map((b) => Object.freeze({ ...b }))
        ),
        openBetaReady: input.openBetaReady === true,
        gaReady: input.gaReady === true,
        productionReady: input.productionReady === true,
        evaluatedAt: Number.isFinite(input.evaluatedAt)
            ? input.evaluatedAt
            : Date.now(),
        evidenceHash: input.evidenceHash
            ? String(input.evidenceHash)
            : null
    });

}
