/**
 * R9.0C — Compliance check result.
 */

import { COMPLIANCE_STATUS } from "../GovernanceConfiguration.js";

/**
 * @param {{
 *   id: string,
 *   name?: string,
 *   policyId?: string|null,
 *   status?: string,
 *   details?: object,
 *   recommendations?: string[]
 * }} input
 */
export function createComplianceResult(input) {

    const key = String(input.status || COMPLIANCE_STATUS.FAILED).toUpperCase();

    const status = COMPLIANCE_STATUS[key] ?? COMPLIANCE_STATUS.FAILED;

    return Object.freeze({
        id: String(input.id),
        name: String(input.name || input.id),
        policyId: input.policyId ? String(input.policyId) : null,
        status,
        details: Object.freeze({ ...(input.details ?? {}) }),
        recommendations: Object.freeze([...(input.recommendations ?? [])])
    });

}
