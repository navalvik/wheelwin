/**
 * R9.0C — Governance metrics aggregation.
 */

export class GovernanceMetricsCollector {

    constructor() {

        this._last = null;

        this._count = 0;

    }

    /**
     * @param {object} bag
     */
    collect(bag) {

        this._count += 1;

        this._last = Object.freeze({
            collectedAt: Date.now(),
            evaluationCount: this._count,
            lifecycle: bag.lifecycle ?? null,
            governanceScore: bag.governanceScore ?? 0,
            auditScore: bag.auditScore ?? 0,
            complianceScore: bag.complianceScore ?? 0,
            riskScore: bag.riskScore ?? 0,
            reviewScore: bag.reviewScore ?? 0,
            policyCount: bag.policyCount ?? 0,
            archiveCount: bag.archiveCount ?? 0,
            trailCount: bag.trailCount ?? 0,
            decisionStatus: bag.decisionStatus ?? null
        });

        return this._last;

    }

    getLatest() {

        return this._last;

    }

}
