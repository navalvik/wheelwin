/**
 * R9.0B — SLA evaluation against KPI snapshot.
 */

import { SLA_STATUS } from "./OperationsConfiguration.js";
import { createSLAResult } from "./models/SLAResult.js";

function evaluate({ id, name, actual, target, higherIsBetter, warnRatio = 0.98 }) {

    let status = SLA_STATUS.FAILED;

    if (!Number.isFinite(actual) || !Number.isFinite(target)) {

        status = SLA_STATUS.WARNING;

    } else if (higherIsBetter) {

        if (actual >= target) {

            status = SLA_STATUS.PASSED;

        } else if (actual >= target * warnRatio) {

            status = SLA_STATUS.WARNING;

        }

    } else if (actual <= target) {

        status = SLA_STATUS.PASSED;

    } else if (actual <= target / warnRatio) {

        status = SLA_STATUS.WARNING;

    }

    return createSLAResult({
        id,
        name,
        status,
        target,
        actual,
        details: { higherIsBetter }
    });

}

export class ServiceSLAManager {

    /**
     * @param {{
     *   availabilityTarget?: number,
     *   latencyTargetMs?: number,
     *   recoveryTarget?: number,
     *   settlementTarget?: number
     * }} [targets]
     */
    constructor(targets = {}) {

        this._targets = Object.freeze({
            availabilityTarget: targets.availabilityTarget ?? 0.995,
            latencyTargetMs: targets.latencyTargetMs ?? 250,
            recoveryTarget: targets.recoveryTarget ?? 0.95,
            settlementTarget: targets.settlementTarget ?? 0.95
        });

        this._latest = null;

    }

    getTargets() {

        return this._targets;

    }

    /**
     * @param {object} kpi
     * @param {object} [ctx]
     */
    evaluate(kpi = {}, ctx = {}) {

        const results = [
            evaluate({
                id: "availability",
                name: "Availability target",
                actual: Number(kpi.availability) || 0,
                target: this._targets.availabilityTarget,
                higherIsBetter: true
            }),
            evaluate({
                id: "latency",
                name: "Latency target",
                actual: Number(kpi.averageLatencyMs) || 0,
                target: this._targets.latencyTargetMs,
                higherIsBetter: false
            }),
            evaluate({
                id: "recovery",
                name: "Recovery target",
                actual: Number(kpi.recoverySuccessRate) || 0,
                target: this._targets.recoveryTarget,
                higherIsBetter: true
            }),
            evaluate({
                id: "settlement",
                name: "Settlement target",
                actual: Number(kpi.settlementSuccessRate) || 0,
                target: this._targets.settlementTarget,
                higherIsBetter: true
            }),
            createSLAResult({
                id: "monitoring",
                name: "Monitoring target",
                status: ctx.monitoring?.enabled === false
                    ? SLA_STATUS.FAILED
                    : (ctx.monitoring == null
                        ? SLA_STATUS.WARNING
                        : SLA_STATUS.PASSED),
                target: 1,
                actual: ctx.monitoring?.enabled === false ? 0 : 1
            }),
            createSLAResult({
                id: "health",
                name: "Health target",
                status: ctx.health?.ready === true
                    || ctx.health?.status === "ok"
                    ? SLA_STATUS.PASSED
                    : (ctx.health?.status === "degraded"
                        ? SLA_STATUS.WARNING
                        : (ctx.health == null
                            ? SLA_STATUS.WARNING
                            : SLA_STATUS.FAILED)),
                target: 1,
                actual: ctx.health?.ready === true ? 1 : 0
            })
        ];

        const passed = results.filter((r) => r.status === SLA_STATUS.PASSED)
            .length;

        const failed = results.filter((r) => r.status === SLA_STATUS.FAILED)
            .length;

        const warned = results.filter((r) => r.status === SLA_STATUS.WARNING)
            .length;

        this._latest = Object.freeze({
            evaluatedAt: Date.now(),
            results: Object.freeze(results),
            passed,
            warned,
            failed,
            score: results.length > 0
                ? Math.round((100 * (passed + warned * 0.5)) / results.length)
                : 0
        });

        return this._latest;

    }

    getLatest() {

        return this._latest;

    }

}
