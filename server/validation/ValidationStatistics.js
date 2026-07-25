/**
 * R7.0H — Aggregate validation statistics.
 */

export class ValidationStatistics {

    constructor() {

        this._scenarios = 0;

        this._passed = 0;

        this._failed = 0;

        this._warnings = 0;

        this._assertions = 0;

        this._totalDurationMs = 0;

        this._metrics = {
            avgTickLatencyMs: null,
            maxTickLatencyMs: null,
            avgEventLoopDelayMs: null,
            avgHttpLatencyMs: null,
            monitoringOverheadMs: null,
            loggingOverheadMs: null,
            retryOverheadMs: null,
            memoryGrowthBytes: null,
            cpuUtilizationPercent: null,
            socketThroughputOps: null
        };

    }

    recordScenario({ passed, warningCount, assertionCount, durationMs }) {

        this._scenarios += 1;

        if (passed) {

            this._passed += 1;

        } else {

            this._failed += 1;

        }

        this._warnings += warningCount ?? 0;

        this._assertions += assertionCount ?? 0;

        this._totalDurationMs += durationMs ?? 0;

    }

    setMetric(key, value) {

        if (Object.prototype.hasOwnProperty.call(this._metrics, key)) {

            this._metrics[key] = value;

        }

    }

    mergeMetrics(partial = {}) {

        for (const [key, value] of Object.entries(partial)) {

            this.setMetric(key, value);

        }

    }

    snapshot() {

        return {
            scenarios: this._scenarios,
            passed: this._passed,
            failed: this._failed,
            warnings: this._warnings,
            assertions: this._assertions,
            totalDurationMs: Number(this._totalDurationMs.toFixed(3)),
            metrics: { ...this._metrics },
            overallPass: this._failed === 0
        };

    }

}
