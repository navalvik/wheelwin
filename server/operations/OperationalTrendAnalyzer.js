/**
 * R9.0B — Operational trend analysis over KPI samples.
 */

export class OperationalTrendAnalyzer {

    /**
     * @param {{ maxSamples?: number }} [options]
     */
    constructor(options = {}) {

        this._max = options.maxSamples ?? 100;

        /** @type {object[]} */
        this._samples = [];

    }

    clear() {

        this._samples = [];

    }

    /**
     * @param {{
     *   kpi: object,
     *   slaScore?: number,
     *   healthScore?: number,
     *   incidentCount?: number,
     *   operationalScore?: number
     * }} sample
     */
    push(sample) {

        this._samples.push(Object.freeze({
            at: Date.now(),
            availability: Number(sample.kpi?.availability) || 0,
            averageLatencyMs: Number(sample.kpi?.averageLatencyMs) || 0,
            crashRate: Number(sample.kpi?.crashRate) || 0,
            recoverySuccessRate:
                Number(sample.kpi?.recoverySuccessRate) || 0,
            paymentSuccessRate: Number(sample.kpi?.paymentSuccessRate) || 0,
            settlementSuccessRate:
                Number(sample.kpi?.settlementSuccessRate) || 0,
            memoryUtilization: Number(sample.kpi?.memoryUtilization) || 0,
            cpuUtilization: Number(sample.kpi?.cpuUtilization) || 0,
            incidentCount: Number(sample.incidentCount) || 0,
            operationalScore: Number(sample.operationalScore) || 0,
            slaScore: Number(sample.slaScore) || 0,
            healthScore: Number(sample.healthScore) || 0
        }));

        if (this._samples.length > this._max) {

            this._samples.splice(0, this._samples.length - this._max);

        }

        return this.analyze();

    }

    analyze() {

        const series = (key) => this._samples.map((s) => s[key]);

        const trendOf = (values) => {

            if (values.length < 2) {

                return "stable";

            }

            const first = values[0];

            const last = values[values.length - 1];

            const delta = last - first;

            if (Math.abs(delta) < 1e-6) {

                return "stable";

            }

            return delta > 0 ? "up" : "down";

        };

        const avg = (values) => {

            if (!values.length) {

                return 0;

            }

            return Number(
                (
                    values.reduce((a, b) => a + b, 0) / values.length
                ).toFixed(4)
            );

        };

        const keys = [
            "availability",
            "averageLatencyMs",
            "crashRate",
            "recoverySuccessRate",
            "paymentSuccessRate",
            "settlementSuccessRate",
            "incidentCount",
            "memoryUtilization",
            "cpuUtilization",
            "operationalScore"
        ];

        const trends = Object.create(null);

        for (const key of keys) {

            const values = series(key);

            trends[key] = Object.freeze({
                samples: values.length,
                average: avg(values),
                latest: values.length ? values[values.length - 1] : 0,
                trend: trendOf(values)
            });

        }

        return Object.freeze({
            sampleCount: this._samples.length,
            analyzedAt: Date.now(),
            trends: Object.freeze(trends)
        });

    }

    getSamples() {

        return [...this._samples];

    }

}
