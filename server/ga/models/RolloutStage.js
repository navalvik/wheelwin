/**
 * R9.0A — Rollout stage snapshot.
 */

import { ROLLOUT_STAGES } from "../ProductionConfiguration.js";

/**
 * @param {{
 *   stage?: string,
 *   enteredAt?: number|null,
 *   completedAt?: number|null,
 *   notes?: string|null
 * }} input
 */
export function createRolloutStage(input = {}) {

    const key = String(input.stage || ROLLOUT_STAGES.INTERNAL).toUpperCase();

    const stage = ROLLOUT_STAGES[key] ?? ROLLOUT_STAGES.INTERNAL;

    return Object.freeze({
        stage,
        enteredAt: Number.isFinite(input.enteredAt) ? input.enteredAt : null,
        completedAt: Number.isFinite(input.completedAt)
            ? input.completedAt
            : null,
        notes: input.notes ? String(input.notes).slice(0, 256) : null
    });

}
