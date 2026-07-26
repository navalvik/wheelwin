/**
 * R8.0E — Aggregate launch metrics (observational).
 */

export class LaunchMetricsCollector {

    constructor() {

        this._last = null;

        this._evaluationCount = 0;

        this._lastDurationMs = 0;

    }

    /**
     * @param {{
     *   openBeta: object,
     *   production: object,
     *   decision: object,
     *   evidenceSummary: object,
     *   durationMs: number,
     *   lifecycle: string
     * }} bag
     */
    collect(bag) {

        this._evaluationCount += 1;

        this._lastDurationMs = bag.durationMs ?? 0;

        const openGates = bag.openBeta?.gates ?? [];

        const prodGates = bag.production?.gates ?? [];

        const allGates = [...openGates, ...prodGates];

        const passed = allGates.filter(
            (g) => g.status === "PASS" || g.status === "WARN"
        ).length;

        const failed = allGates.filter((g) => g.status === "FAIL").length;

        const blockers = bag.decision?.blockers ?? [];

        this._last = Object.freeze({
            collectedAt: Date.now(),
            evaluationCount: this._evaluationCount,
            evaluationDurationMs: this._lastDurationMs,
            lifecycle: bag.lifecycle,
            decision: bag.decision?.decision ?? null,
            score: bag.decision?.score ?? 0,
            gatePassRate: allGates.length > 0
                ? Number((passed / allGates.length).toFixed(4))
                : 0,
            gateFailureCount: failed,
            criticalBlockers: blockers.filter(
                (b) => b.severity === "CRITICAL"
            ).length,
            highBlockers: blockers.filter(
                (b) => b.severity === "HIGH"
            ).length,
            operationalReadinessScore: bag.decision?.score ?? 0,
            documentationCompleteness:
                bag.production?.documentationCompleteness ?? 0,
            monitoringStatus: bag.monitoringStatus ?? null,
            healthScore: bag.health?.ready === true
                ? 100
                : (bag.health?.status === "ok" ? 100 : 0),
            evidenceCount: bag.evidenceSummary?.total ?? 0,
            openBetaReady: bag.decision?.openBetaReady === true,
            gaReady: bag.decision?.gaReady === true,
            productionReady: bag.decision?.productionReady === true
        });

        return this._last;

    }

    getLatest() {

        return this._last;

    }

}
