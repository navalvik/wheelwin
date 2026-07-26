/**
 * R9.0C — Periodic platform review record.
 */

let _seq = 0;

function nextId() {

    _seq += 1;

    return `review-${Date.now().toString(36)}-${_seq}`;

}

/**
 * @param {{
 *   id?: string,
 *   timestamp?: number,
 *   operationalHealth?: object,
 *   kpiOverview?: object,
 *   slaOverview?: object,
 *   incidentSummary?: object,
 *   maintenanceHistory?: object,
 *   releaseHistory?: object,
 *   riskSummary?: object,
 *   complianceSummary?: object,
 *   recommendations?: string[],
 *   score?: number
 * }} input
 */
export function createPlatformReview(input = {}) {

    return Object.freeze({
        id: input.id ? String(input.id) : nextId(),
        timestamp: Number.isFinite(input.timestamp)
            ? input.timestamp
            : Date.now(),
        operationalHealth: Object.freeze({
            ...(input.operationalHealth ?? {})
        }),
        kpiOverview: Object.freeze({ ...(input.kpiOverview ?? {}) }),
        slaOverview: Object.freeze({ ...(input.slaOverview ?? {}) }),
        incidentSummary: Object.freeze({ ...(input.incidentSummary ?? {}) }),
        maintenanceHistory: Object.freeze({
            ...(input.maintenanceHistory ?? {})
        }),
        releaseHistory: Object.freeze({ ...(input.releaseHistory ?? {}) }),
        riskSummary: Object.freeze({ ...(input.riskSummary ?? {}) }),
        complianceSummary: Object.freeze({
            ...(input.complianceSummary ?? {})
        }),
        recommendations: Object.freeze([...(input.recommendations ?? [])]),
        score: Number.isFinite(input.score) ? input.score : 0
    });

}

export function resetPlatformReviewIdSequenceForTests() {

    _seq = 0;

}
