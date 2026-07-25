/**
 * R7.0E — Base metrics collector (observational only).
 */

export class MetricCollector {

    /**
     * @param {{ name: string, intervalMs: number }} options
     */
    constructor({ name, intervalMs }) {

        this.name = name;

        this.intervalMs = intervalMs;

        this._lastCollectedAt = null;

        this._lastError = null;

        this._successCount = 0;

        this._failureCount = 0;

    }

    /**
     * @param {{
     *   registry: import("./MetricsRegistry.js").MetricsRegistry,
     *   providers: object,
     *   now: number
     * }} context
     */
    collect(context) {

        throw new Error(`Collector ${this.name} must implement collect()`);

    }

    markSuccess() {

        this._lastCollectedAt = Date.now();

        this._lastError = null;

        this._successCount += 1;

    }

    markFailure(error) {

        this._lastError = error?.message ?? String(error);

        this._failureCount += 1;

    }

    getStatus() {

        return {
            name: this.name,
            intervalMs: this.intervalMs,
            lastCollectedAt: this._lastCollectedAt,
            lastError: this._lastError,
            successCount: this._successCount,
            failureCount: this._failureCount,
            healthy: this._failureCount === 0
                || (this._successCount > 0 && this._lastError == null)
        };

    }

}
