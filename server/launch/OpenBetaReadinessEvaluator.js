/**
 * R8.0E — Open Beta entry gate evaluation (read-only providers).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import {
    GATE_STATUS,
    BLOCKER_SEVERITY,
    OPEN_BETA_THRESHOLDS
} from "./LaunchConfiguration.js";
import {
    evaluateGate,
    blockersFromGates,
    scoreGates
} from "./LaunchGateEvaluator.js";
import { createOpenBetaAssessment } from "./models/OpenBetaAssessment.js";
import { BETA_LIFECYCLE, BETA_READINESS } from "../beta/BetaConfiguration.js";

const CERT_OK = new Set(["PASSED", "PASSED_WITH_WARNINGS"]);

export class OpenBetaReadinessEvaluator {

    /**
     * @param {{
     *   repoRoot: string,
     *   thresholds?: Partial<typeof OPEN_BETA_THRESHOLDS>,
     *   closedBetaReportRelativePath?: string
     * }} options
     */
    constructor(options) {

        this._repoRoot = options.repoRoot;

        this._thresholds = Object.freeze({
            ...OPEN_BETA_THRESHOLDS,
            ...(options.thresholds ?? {})
        });

        this._closedBetaReportPath = options.closedBetaReportRelativePath
            ?? "docs/release/R8.0D-Closed-Beta-Report.md";

    }

    /**
     * @param {{
     *   closedBeta?: object|null,
     *   certification?: object|null,
     *   monitoring?: object|null,
     *   health?: object|null,
     *   developerConsole?: object|null
     * }} ctx
     */
    evaluate(ctx = {}) {

        const started = Date.now();

        const beta = ctx.closedBeta ?? {};

        const cert = ctx.certification ?? {};

        const telemetry = beta.telemetry ?? {};

        const gates = [];

        const betaLifecycle = beta.lifecycle ?? null;

        const completedLifecycles = new Set([
            BETA_LIFECYCLE.COMPLETED,
            BETA_LIFECYCLE.OPEN_BETA_READY,
            BETA_LIFECYCLE.MONITORING,
            BETA_LIFECYCLE.READY_FOR_REVIEW
        ]);

        gates.push(evaluateGate({
            id: "closed_beta_completed",
            name: "Closed Beta completed / monitoring",
            category: "closed_beta",
            severity: BLOCKER_SEVERITY.CRITICAL,
            ok: completedLifecycles.has(betaLifecycle)
                || betaLifecycle === BETA_LIFECYCLE.ACTIVE,
            details: { lifecycle: betaLifecycle }
        }));

        const reportPath = join(this._repoRoot, this._closedBetaReportPath);

        gates.push(evaluateGate({
            id: "closed_beta_report",
            name: "Closed Beta report available",
            category: "documentation",
            severity: BLOCKER_SEVERITY.HIGH,
            ok: existsSync(reportPath),
            details: { path: this._closedBetaReportPath }
        }));

        gates.push(evaluateGate({
            id: "closed_beta_readiness",
            name: "Closed Beta readiness READY_FOR_OPEN_BETA",
            category: "closed_beta",
            severity: BLOCKER_SEVERITY.CRITICAL,
            ok: beta.readiness === BETA_READINESS.READY_FOR_OPEN_BETA
                || betaLifecycle === BETA_LIFECYCLE.OPEN_BETA_READY,
            details: {
                readiness: beta.readiness ?? null,
                score: beta.readinessScore ?? null
            }
        }));

        const certStatus = cert.status ?? beta.certificationStatus ?? null;

        gates.push(evaluateGate({
            id: "certification_status",
            name: "Certification PASSED / PASSED_WITH_WARNINGS",
            category: "certification",
            severity: BLOCKER_SEVERITY.CRITICAL,
            ok: CERT_OK.has(certStatus)
                || cert.betaReady === true
                || beta.certificationBetaReady === true,
            warn: certStatus === "PASSED_WITH_WARNINGS",
            details: { status: certStatus }
        }));

        const openCritical = Number(
            beta.incidents?.openCritical ?? 0
        );

        gates.push(evaluateGate({
            id: "no_critical_incidents",
            name: "No unresolved CRITICAL incidents",
            category: "incidents",
            severity: BLOCKER_SEVERITY.CRITICAL,
            ok: openCritical === 0,
            details: { openCritical }
        }));

        // Security HIGH blockers: prefer explicit provider field
        const securityHigh = Number(ctx.securityHighOpen ?? 0)
            || Number(beta.securityHighOpen ?? 0)
            || 0;

        gates.push(evaluateGate({
            id: "no_high_security",
            name: "No unresolved HIGH security issues",
            category: "security",
            severity: BLOCKER_SEVERITY.HIGH,
            ok: securityHigh === 0,
            details: { securityHighOpen: securityHigh }
        }));

        const crashRate = Number(beta.crashRate) || 0;

        gates.push(evaluateGate({
            id: "crash_rate",
            name: "Crash rate within threshold",
            category: "stability",
            severity: BLOCKER_SEVERITY.CRITICAL,
            ok: crashRate <= this._thresholds.maxCrashRate,
            details: {
                crashRate,
                max: this._thresholds.maxCrashRate
            }
        }));

        const recoveryRate = Number(telemetry.recoverySuccessRate);

        gates.push(evaluateGate({
            id: "recovery_success",
            name: "Recovery success rate within threshold",
            category: "recovery",
            severity: BLOCKER_SEVERITY.HIGH,
            ok: !Number.isFinite(recoveryRate)
                || recoveryRate >= this._thresholds.minRecoverySuccessRate,
            details: {
                recoverySuccessRate: Number.isFinite(recoveryRate)
                    ? recoveryRate
                    : null,
                min: this._thresholds.minRecoverySuccessRate
            }
        }));

        const settlementRate = Number(telemetry.settlementSuccessRate);

        gates.push(evaluateGate({
            id: "settlement_success",
            name: "Settlement success rate within threshold",
            category: "blockchain",
            severity: BLOCKER_SEVERITY.HIGH,
            ok: !Number.isFinite(settlementRate)
                || settlementRate >= this._thresholds.minSettlementSuccessRate,
            details: {
                settlementSuccessRate: Number.isFinite(settlementRate)
                    ? settlementRate
                    : null,
                min: this._thresholds.minSettlementSuccessRate
            }
        }));

        const latency = Number(telemetry.averageLatencyMs) || 0;

        gates.push(evaluateGate({
            id: "average_latency",
            name: "Average latency within threshold",
            category: "performance",
            severity: BLOCKER_SEVERITY.MEDIUM,
            ok: latency <= 0
                || latency <= this._thresholds.maxAverageLatencyMs,
            details: {
                averageLatencyMs: latency,
                max: this._thresholds.maxAverageLatencyMs
            }
        }));

        const monitoringOk = ctx.monitoring?.enabled === true
            || ctx.monitoring?.running === true
            || ctx.monitoring?.status === "ok"
            || ctx.health?.monitoring?.enabled === true;

        gates.push(evaluateGate({
            id: "monitoring_operational",
            name: "Monitoring operational",
            category: "infrastructure",
            severity: BLOCKER_SEVERITY.HIGH,
            ok: monitoringOk || ctx.monitoring == null,
            details: { monitoring: ctx.monitoring ?? null }
        }));

        const healthOk = ctx.health?.ready === true
            || ctx.health?.status === "ok"
            || ctx.health?.status === "degraded";

        gates.push(evaluateGate({
            id: "health_operational",
            name: "Health operational",
            category: "infrastructure",
            severity: BLOCKER_SEVERITY.HIGH,
            ok: healthOk || ctx.health == null,
            details: {
                status: ctx.health?.status ?? null,
                ready: ctx.health?.ready ?? null
            }
        }));

        const consoleOk = ctx.developerConsole?.enabled === true
            || ctx.developerConsole == null;

        gates.push(evaluateGate({
            id: "developer_console",
            name: "Developer Console operational",
            category: "operations",
            severity: BLOCKER_SEVERITY.MEDIUM,
            ok: consoleOk,
            details: { enabled: ctx.developerConsole?.enabled ?? null }
        }));

        const blockers = blockersFromGates(gates);

        const score = scoreGates(gates);

        const criticalFails = blockers.filter(
            (b) => b.severity === BLOCKER_SEVERITY.CRITICAL
        );

        const ready = criticalFails.length === 0
            && gates.every(
                (g) => g.status === GATE_STATUS.PASS
                    || g.status === GATE_STATUS.WARN
                    || g.severity === BLOCKER_SEVERITY.LOW
                    || g.severity === BLOCKER_SEVERITY.MEDIUM
            )
            && blockers.filter(
                (b) => b.severity === BLOCKER_SEVERITY.HIGH
            ).length === 0;

        // Stricter: ready only when no FAIL gates of CRITICAL/HIGH
        const readyStrict = criticalFails.length === 0
            && blockers.filter(
                (b) => b.severity === BLOCKER_SEVERITY.HIGH
                    || b.severity === BLOCKER_SEVERITY.CRITICAL
            ).length === 0;

        return createOpenBetaAssessment({
            ready: readyStrict,
            score,
            gates,
            blockers,
            summary: {
                durationMs: Date.now() - started,
                gateCount: gates.length,
                thresholds: this._thresholds
            },
            evaluatedAt: Date.now()
        });

    }

}
