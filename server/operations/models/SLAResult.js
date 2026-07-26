/**
 * R9.0B — SLA evaluation result.
 */

import { SLA_STATUS } from "../OperationsConfiguration.js";

/**
 * @param {{
 *   id: string,
 *   name?: string,
 *   status?: string,
 *   target?: number|null,
 *   actual?: number|null,
 *   details?: object
 * }} input
 */
export function createSLAResult(input) {

    const key = String(input.status || SLA_STATUS.FAILED).toUpperCase();

    const status = SLA_STATUS[key] ?? SLA_STATUS.FAILED;

    return Object.freeze({
        id: String(input.id),
        name: String(input.name || input.id),
        status,
        target: Number.isFinite(input.target) ? input.target : null,
        actual: Number.isFinite(input.actual) ? input.actual : null,
        details: Object.freeze({ ...(input.details ?? {}) })
    });

}
