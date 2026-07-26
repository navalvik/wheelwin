/**
 * R9.0B — Aggregate operational metrics bag.
 */

export class OperationalMetricsCollector {

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
            operationalScore: bag.operationalScore ?? 0,
            kpi: bag.kpi ? Object.freeze({ ...bag.kpi }) : null,
            slaScore: bag.slaScore ?? 0,
            slaFailed: bag.slaFailed ?? 0,
            maintenanceActive: bag.maintenanceActive === true,
            incidentOpen: bag.incidentOpen ?? 0,
            incidentOpenCritical: bag.incidentOpenCritical ?? 0,
            activeVersion: bag.activeVersion ?? null,
            evidenceCount: bag.evidenceCount ?? 0
        });

        return this._last;

    }

    getLatest() {

        return this._last;

    }

}
