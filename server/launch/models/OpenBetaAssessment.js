/**
 * R8.0E — Open Beta assessment snapshot.
 */

/**
 * @param {{
 *   ready?: boolean,
 *   score?: number,
 *   gates?: object[],
 *   blockers?: object[],
 *   summary?: object,
 *   evaluatedAt?: number
 * }} input
 */
export function createOpenBetaAssessment(input = {}) {

    return Object.freeze({
        ready: input.ready === true,
        score: Number.isFinite(input.score) ? input.score : 0,
        gates: Object.freeze([...(input.gates ?? [])]),
        blockers: Object.freeze(
            (input.blockers ?? []).map((b) => Object.freeze({ ...b }))
        ),
        summary: Object.freeze({ ...(input.summary ?? {}) }),
        evaluatedAt: Number.isFinite(input.evaluatedAt)
            ? input.evaluatedAt
            : Date.now()
    });

}
