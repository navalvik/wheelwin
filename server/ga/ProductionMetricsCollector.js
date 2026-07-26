/**
 * R9.0A — GA production metrics aggregation.
 */

export class ProductionMetricsCollector {

    constructor() {

        this._last = null;

        this._evaluationCount = 0;

    }

    /**
     * @param {{
     *   lifecycle: string,
     *   releaseDurationMs?: number,
     *   verificationDurationMs?: number,
     *   rolloutDurationMs?: number,
     *   verificationScore?: number,
     *   healthScore?: number,
     *   deploymentScore?: number,
     *   operationalScore?: number,
     *   incidentCount?: number,
     *   rollbackRecommended?: boolean,
     *   gaUptimeMs?: number,
     *   evidenceCount?: number
     * }} bag
     */
    collect(bag) {

        this._evaluationCount += 1;

        this._last = Object.freeze({
            collectedAt: Date.now(),
            evaluationCount: this._evaluationCount,
            lifecycle: bag.lifecycle,
            releaseDurationMs: bag.releaseDurationMs ?? 0,
            verificationDurationMs: bag.verificationDurationMs ?? 0,
            rolloutDurationMs: bag.rolloutDurationMs ?? 0,
            healthScore: bag.healthScore ?? 0,
            deploymentScore: bag.deploymentScore ?? 0,
            operationalScore: bag.operationalScore ?? 0,
            verificationScore: bag.verificationScore ?? 0,
            incidentCount: bag.incidentCount ?? 0,
            rollbackRecommended: bag.rollbackRecommended === true,
            gaUptimeMs: bag.gaUptimeMs ?? 0,
            evidenceCount: bag.evidenceCount ?? 0
        });

        return this._last;

    }

    getLatest() {

        return this._last;

    }

}
