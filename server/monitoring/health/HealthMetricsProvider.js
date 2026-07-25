/**
 * R7.0E — Bridge MonitoringManager → HealthService safe status.
 */

export class HealthMetricsProvider {

    /**
     * @param {import("../MonitoringManager.js").MonitoringManager} monitoringManager
     */
    constructor(monitoringManager) {

        this._monitoring = monitoringManager;

    }

    getStatus() {

        const snapshot = this._monitoring.getSnapshot();

        const collectors = snapshot?.collectors ?? {};

        const collectorList = Object.values(collectors);

        const failures = collectorList.filter((c) => c.lastError).length;

        return Object.freeze({
            enabled: this._monitoring.isEnabled(),
            running: this._monitoring.isRunning(),
            lastCollectionAt: snapshot?.collectedAt ?? null,
            freshnessMs: snapshot
                ? Math.max(0, Date.now() - snapshot.collectedAt)
                : null,
            collectorCount: collectorList.length,
            collectorFailures: failures,
            collectors: Object.freeze({ ...collectors }),
            prometheusEnabled: this._monitoring.isPrometheusEnabled()
        });

    }

}
