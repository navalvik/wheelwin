/**
 * R9.0B — Service state snapshot.
 */

import { SERVICE_LIFECYCLE } from "../OperationsConfiguration.js";

/**
 * @param {{
 *   lifecycle?: string,
 *   since?: number|null,
 *   notes?: string|null
 * }} input
 */
export function createServiceState(input = {}) {

    const key = String(
        input.lifecycle || SERVICE_LIFECYCLE.GA_ACTIVE
    ).toUpperCase();

    const lifecycle = SERVICE_LIFECYCLE[key] ?? SERVICE_LIFECYCLE.GA_ACTIVE;

    return Object.freeze({
        lifecycle,
        since: Number.isFinite(input.since) ? input.since : Date.now(),
        notes: input.notes ? String(input.notes).slice(0, 256) : null
    });

}
