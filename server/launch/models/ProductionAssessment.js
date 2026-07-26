/**
 * R8.0E — Production / GA assessment snapshot.
 */

/**
 * @param {{
 *   ready?: boolean,
 *   score?: number,
 *   gates?: object[],
 *   blockers?: object[],
 *   summary?: object,
 *   documentationCompleteness?: number,
 *   evaluatedAt?: number
 * }} input
 */
export function createProductionAssessment(input = {}) {

    return Object.freeze({
        ready: input.ready === true,
        score: Number.isFinite(input.score) ? input.score : 0,
        gates: Object.freeze([...(input.gates ?? [])]),
        blockers: Object.freeze(
            (input.blockers ?? []).map((b) => Object.freeze({ ...b }))
        ),
        summary: Object.freeze({ ...(input.summary ?? {}) }),
        documentationCompleteness: Number.isFinite(
            input.documentationCompleteness
        )
            ? input.documentationCompleteness
            : 0,
        evaluatedAt: Number.isFinite(input.evaluatedAt)
            ? input.evaluatedAt
            : Date.now()
    });

}
