/**
 * R9.0A — Production verification aggregate result.
 */

import { VERIFICATION_STATUS } from "../ProductionConfiguration.js";

/**
 * @param {{
 *   status?: string,
 *   score?: number,
 *   checks?: object[],
 *   durationMs?: number,
 *   evidenceHash?: string|null,
 *   evaluatedAt?: number
 * }} input
 */
export function createProductionVerificationResult(input = {}) {

    const key = String(
        input.status || VERIFICATION_STATUS.PENDING
    ).toUpperCase();

    const status = VERIFICATION_STATUS[key] ?? VERIFICATION_STATUS.PENDING;

    return Object.freeze({
        status,
        score: Number.isFinite(input.score) ? input.score : 0,
        checks: Object.freeze([...(input.checks ?? [])]),
        durationMs: Number.isFinite(input.durationMs) ? input.durationMs : 0,
        evidenceHash: input.evidenceHash
            ? String(input.evidenceHash)
            : null,
        evaluatedAt: Number.isFinite(input.evaluatedAt)
            ? input.evaluatedAt
            : Date.now()
    });

}
