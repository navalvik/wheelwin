/**
 * R8.0D — Automatic Closed Beta → Open Beta readiness evaluation.
 */

import { BETA_READINESS } from "./BetaConfiguration.js";

/**
 * Thresholds are intentional and documented; purely observational scoring.
 */
export const READINESS_THRESHOLDS = Object.freeze({
    maxCrashRate: 0.05,
    maxOpenCriticalIncidents: 0,
    maxAverageLatencyMs: 250,
    minRecoverySuccessRate: 0.95,
    minPaymentSuccessRate: 0.95,
    maxDesyncCount: 0,
    maxOpenHighFeedback: 3,
    maxAuthoritativeSyncFailures: 0
});

export class BetaReadinessEvaluator {

    /**
     * @param {{ thresholds?: Partial<typeof READINESS_THRESHOLDS> }} [options]
     */
    constructor(options = {}) {

        this._thresholds = Object.freeze({
            ...READINESS_THRESHOLDS,
            ...(options.thresholds ?? {})
        });

    }

    getThresholds() {

        return this._thresholds;

    }

    /**
     * @param {{
     *   metrics: object,
     *   lifecycle?: string,
     *   certification?: { betaReady?: boolean, status?: string }|null
     * }} input
     */
    evaluate(input) {

        const metrics = input.metrics ?? {};

        const telemetry = metrics.telemetry ?? {};

        const session = telemetry.session ?? {};

        const network = telemetry.network ?? {};

        const recovery = telemetry.recovery ?? {};

        const payment = telemetry.payment ?? {};

        const gameplay = telemetry.gameplay ?? {};

        const incidents = metrics.incidents ?? {};

        const checks = [];

        const push = (id, ok, detail, weight = "hard") => {

            checks.push(Object.freeze({ id, ok: ok === true, detail, weight }));

        };

        const crashRate = Number(metrics.crashRate) || 0;

        push(
            "crash_rate",
            crashRate <= this._thresholds.maxCrashRate,
            `crashRate=${crashRate} (max ${this._thresholds.maxCrashRate})`
        );

        const openCritical = Number(incidents.openCritical) || 0;

        push(
            "critical_incidents",
            openCritical <= this._thresholds.maxOpenCriticalIncidents,
            `openCritical=${openCritical}`
        );

        const latency = Number(network.averageLatencyMs) || 0;

        // Latency only gates when samples exist
        const latencyOk = latency <= 0
            || latency <= this._thresholds.maxAverageLatencyMs;

        push(
            "average_latency",
            latencyOk,
            `averageLatencyMs=${latency}`
        );

        const recoveryRate = Number(recovery.recoverySuccessRate);

        const recoveryOk = !Number.isFinite(recoveryRate)
            || recovery.recoveryAttempts === 0
            || recoveryRate >= this._thresholds.minRecoverySuccessRate;

        push(
            "recovery_success",
            recoveryOk,
            `recoverySuccessRate=${recovery.recoverySuccessRate ?? "n/a"}`
        );

        const payRate = Number(payment.settlementSuccessRate);

        const paymentOk = !Number.isFinite(payRate)
            || (payment.paymentsCompleted + payment.paymentsFailed) === 0
            || payRate >= this._thresholds.minPaymentSuccessRate;

        push(
            "payment_success",
            paymentOk,
            `settlementSuccessRate=${payment.settlementSuccessRate ?? "n/a"}`
        );

        const desync = Number(gameplay.desynchronizationCount) || 0;

        const syncFail = Number(gameplay.authoritativeSyncFailures) || 0;

        push(
            "gameplay_integrity",
            desync <= this._thresholds.maxDesyncCount
                && syncFail <= this._thresholds.maxAuthoritativeSyncFailures,
            `desync=${desync} syncFailures=${syncFail}`
        );

        const highFeedback = Number(
            input.metrics?.feedbackHighOpen
                ?? input.openHighFeedback
                ?? 0
        );

        push(
            "feedback_severity",
            highFeedback <= this._thresholds.maxOpenHighFeedback,
            `openHighFeedback=${highFeedback}`
        );

        const cert = input.certification;

        if (cert) {

            push(
                "certification",
                cert.betaReady === true,
                `certification=${cert.status ?? "unknown"}`
            );

        }

        const hardFails = checks.filter((c) => !c.ok && c.weight === "hard");

        const softFails = checks.filter((c) => !c.ok && c.weight === "soft");

        let readiness = BETA_READINESS.READY_FOR_OPEN_BETA;

        if (hardFails.length >= 3
            || hardFails.some((c) =>
                c.id === "critical_incidents"
                || c.id === "gameplay_integrity"
                || c.id === "certification")) {

            readiness = BETA_READINESS.NOT_READY;

        } else if (hardFails.length > 0 || softFails.length > 0) {

            readiness = BETA_READINESS.NEEDS_ATTENTION;

        }

        // No completed games yet → not ready for open beta
        if ((session.gamesCompleted ?? 0) < 1
            && readiness === BETA_READINESS.READY_FOR_OPEN_BETA) {

            readiness = BETA_READINESS.NEEDS_ATTENTION;

            checks.push(Object.freeze({
                id: "sample_size",
                ok: false,
                detail: "No completed games observed yet",
                weight: "soft"
            }));

        }

        const score = Math.max(
            0,
            Math.round(
                (100 * checks.filter((c) => c.ok).length)
                / Math.max(1, checks.length)
            )
        );

        return Object.freeze({
            readiness,
            score,
            evaluatedAt: Date.now(),
            checks: Object.freeze(checks),
            thresholds: this._thresholds
        });

    }

}
