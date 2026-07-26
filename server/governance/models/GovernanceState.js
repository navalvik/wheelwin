/**
 * R9.0C — Governance state snapshot.
 */

import { GOVERNANCE_LIFECYCLE } from "../GovernanceConfiguration.js";

/**
 * @param {{
 *   lifecycle?: string,
 *   since?: number|null,
 *   cycle?: number,
 *   notes?: string|null
 * }} input
 */
export function createGovernanceState(input = {}) {

    const key = String(
        input.lifecycle || GOVERNANCE_LIFECYCLE.PLATFORM_ACTIVE
    ).toUpperCase();

    const lifecycle = GOVERNANCE_LIFECYCLE[key]
        ?? GOVERNANCE_LIFECYCLE.PLATFORM_ACTIVE;

    return Object.freeze({
        lifecycle,
        since: Number.isFinite(input.since) ? input.since : Date.now(),
        cycle: Number.isFinite(input.cycle) ? input.cycle : 0,
        notes: input.notes ? String(input.notes).slice(0, 256) : null
    });

}
