/**
 * R9.0C — Immutable governance policy.
 */

import { POLICY_APPROVAL } from "../GovernanceConfiguration.js";

/**
 * @param {{
 *   id: string,
 *   version?: string,
 *   description?: string,
 *   validationRules?: string[],
 *   effectiveDate?: number,
 *   reviewIntervalDays?: number,
 *   approvalStatus?: string
 * }} input
 */
export function createGovernancePolicy(input) {

    const key = String(
        input.approvalStatus || POLICY_APPROVAL.APPROVED
    ).toUpperCase();

    const approvalStatus = POLICY_APPROVAL[key] ?? POLICY_APPROVAL.APPROVED;

    return Object.freeze({
        id: String(input.id).slice(0, 64),
        version: String(input.version || "1.0").slice(0, 32),
        description: String(input.description || "").slice(0, 500),
        validationRules: Object.freeze(
            [...(input.validationRules ?? [])].map((r) => String(r).slice(0, 200))
        ),
        effectiveDate: Number.isFinite(input.effectiveDate)
            ? input.effectiveDate
            : Date.now(),
        reviewIntervalDays: Number.isFinite(input.reviewIntervalDays)
            ? input.reviewIntervalDays
            : 90,
        approvalStatus
    });

}
