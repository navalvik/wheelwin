/**
 * R9.0C — Risk assessment result.
 */

import {
    RISK_SEVERITY,
    RISK_CATEGORY
} from "../GovernanceConfiguration.js";

/**
 * @param {{
 *   id: string,
 *   category?: string,
 *   severity?: string,
 *   score?: number,
 *   summary?: string,
 *   details?: object,
 *   recommendations?: string[]
 * }} input
 */
export function createRiskAssessment(input) {

    const severityKey = String(input.severity || RISK_SEVERITY.LOW)
        .toUpperCase();

    const severity = RISK_SEVERITY[severityKey] ?? RISK_SEVERITY.LOW;

    const categoryValues = Object.values(RISK_CATEGORY);

    const category = categoryValues.includes(input.category)
        ? input.category
        : (RISK_CATEGORY[String(input.category || "").toUpperCase()]
            ?? RISK_CATEGORY.OPERATIONAL);

    return Object.freeze({
        id: String(input.id),
        category,
        severity,
        score: Number.isFinite(input.score) ? input.score : 0,
        summary: String(input.summary || "").slice(0, 300),
        details: Object.freeze({ ...(input.details ?? {}) }),
        recommendations: Object.freeze([...(input.recommendations ?? [])])
    });

}
