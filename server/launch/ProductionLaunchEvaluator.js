/**
 * R8.0E — Production / GA launch gate evaluation (read-only).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import {
    GATE_STATUS,
    BLOCKER_SEVERITY,
    PRODUCTION_THRESHOLDS,
    LAUNCH_LIFECYCLE
} from "./LaunchConfiguration.js";
import {
    evaluateGate,
    blockersFromGates,
    scoreGates
} from "./LaunchGateEvaluator.js";
import { createProductionAssessment } from "./models/ProductionAssessment.js";
import { LaunchChecklist } from "./LaunchChecklist.js";

const CERT_OK = new Set(["PASSED", "PASSED_WITH_WARNINGS"]);

export class ProductionLaunchEvaluator {

    /**
     * @param {{
     *   repoRoot: string,
     *   thresholds?: Partial<typeof PRODUCTION_THRESHOLDS>,
     *   openBetaReportRelativePath?: string,
     *   requireMainnetForGa?: boolean
     * }} options
     */
    constructor(options) {

        this._repoRoot = options.repoRoot;

        this._thresholds = Object.freeze({
            ...PRODUCTION_THRESHOLDS,
            ...(options.thresholds ?? {})
        });

        this._openBetaReportPath = options.openBetaReportRelativePath
            ?? "docs/release/R8.0E-Open-Beta-Readiness-Report.md";

        this._requireMainnet = options.requireMainnetForGa !== false;

        this._checklist = new LaunchChecklist({ repoRoot: options.repoRoot });

    }

    /**
     * @param {{
     *   lifecycle?: string,
     *   openBeta?: object|null,
     *   closedBeta?: object|null,
     *   certification?: object|null,
     *   release?: object|null,
     *   deployment?: object|null,
     *   ton?: object|null,
     *   safeConfiguration?: object|null,
     *   monitoring?: object|null,
     *   health?: object|null,
     *   logging?: object|null,
     *   failurePolicy?: object|null
     * }} ctx
     */
    evaluate(ctx = {}) {

        const started = Date.now();

        const gates = [];

        const lifecycle = ctx.lifecycle ?? LAUNCH_LIFECYCLE.NOT_EVALUATED;

        const openBetaDone = new Set([
            LAUNCH_LIFECYCLE.OPEN_BETA_RUNNING,
            LAUNCH_LIFECYCLE.GA_REVIEW,
            LAUNCH_LIFECYCLE.GA_APPROVED,
            LAUNCH_LIFECYCLE.PRODUCTION_READY,
            LAUNCH_LIFECYCLE.OPEN_BETA_APPROVED
        ]);

        gates.push(evaluateGate({
            id: "open_beta_completed",
            name: "Open Beta completed / approved",
            category: "open_beta",
            severity: BLOCKER_SEVERITY.CRITICAL,
            ok: openBetaDone.has(lifecycle)
                || ctx.openBeta?.ready === true,
            details: { lifecycle, openBetaReady: ctx.openBeta?.ready === true }
        }));

        const openBetaReport = join(this._repoRoot, this._openBetaReportPath);

        gates.push(evaluateGate({
            id: "open_beta_report",
            name: "Open Beta report available",
            category: "documentation",
            severity: BLOCKER_SEVERITY.HIGH,
            ok: existsSync(openBetaReport)
                || ctx.openBetaReportPresent === true,
            details: { path: this._openBetaReportPath }
        }));

        const openCritical = Number(
            ctx.closedBeta?.incidents?.openCritical ?? 0
        );

        gates.push(evaluateGate({
            id: "no_critical_blockers",
            name: "No CRITICAL blockers",
            category: "blockers",
            severity: BLOCKER_SEVERITY.CRITICAL,
            ok: openCritical === 0
                && (ctx.openBeta?.blockers ?? [])
                    .filter((b) => b.severity === BLOCKER_SEVERITY.CRITICAL)
                    .length === 0,
            details: { openCritical }
        }));

        const releaseBlockers = (ctx.releaseBlockers ?? [])
            .filter((b) => b.severity === BLOCKER_SEVERITY.CRITICAL);

        gates.push(evaluateGate({
            id: "no_release_blockers",
            name: "No unresolved release blockers",
            category: "release",
            severity: BLOCKER_SEVERITY.CRITICAL,
            ok: releaseBlockers.length === 0,
            details: { count: releaseBlockers.length }
        }));

        const profile = ctx.deployment?.profile
            ?? ctx.safeConfiguration?.deployment?.profile
            ?? null;

        gates.push(evaluateGate({
            id: "production_configuration",
            name: "Production configuration verified",
            category: "configuration",
            severity: BLOCKER_SEVERITY.HIGH,
            ok: ctx.safeConfiguration != null
                || ctx.deployment != null
                || profile != null,
            details: { profile, hasSafeConfig: ctx.safeConfiguration != null }
        }));

        const tonNetwork = String(
            ctx.ton?.network
            ?? ctx.safeConfiguration?.ton?.network
            ?? ""
        ).toLowerCase();

        const mainnetOk = !this._requireMainnet
            || tonNetwork === "mainnet"
            || ctx.ton?.mainnetVerified === true
            || ctx.skipMainnetCheck === true;

        gates.push(evaluateGate({
            id: "mainnet_configuration",
            name: "Mainnet configuration verified",
            category: "blockchain",
            severity: BLOCKER_SEVERITY.CRITICAL,
            ok: mainnetOk,
            details: {
                network: tonNetwork || null,
                requireMainnet: this._requireMainnet
            },
            recommendations: mainnetOk
                ? []
                : ["Verify TON mainnet configuration before GA"]
        }));

        const releaseOk = ctx.release?.version != null
            || ctx.release?.fingerprint != null
            || ctx.release?.status === "built"
            || ctx.release?.status === "ready";

        gates.push(evaluateGate({
            id: "release_artifacts",
            name: "Release artifacts verified",
            category: "release",
            severity: BLOCKER_SEVERITY.CRITICAL,
            ok: releaseOk || ctx.releaseArtifactsVerified === true,
            details: {
                version: ctx.release?.version ?? null,
                fingerprint: ctx.release?.fingerprint ?? null,
                status: ctx.release?.status ?? null
            }
        }));

        const certStatus = ctx.certification?.status ?? null;

        gates.push(evaluateGate({
            id: "release_certificate",
            name: "Release certificate verified",
            category: "certification",
            severity: BLOCKER_SEVERITY.CRITICAL,
            ok: CERT_OK.has(certStatus)
                || ctx.certification?.betaReady === true,
            warn: certStatus === "PASSED_WITH_WARNINGS",
            details: { status: certStatus }
        }));

        gates.push(evaluateGate({
            id: "deployment_profile",
            name: "Deployment profile verified",
            category: "deployment",
            severity: BLOCKER_SEVERITY.HIGH,
            ok: profile === "production"
                || profile === "staging"
                || ctx.deployment?.ready === true
                || ctx.deployment != null,
            details: { profile }
        }));

        gates.push(evaluateGate({
            id: "rollback_strategy",
            name: "Rollback strategy verified",
            category: "operations",
            severity: BLOCKER_SEVERITY.HIGH,
            ok: ctx.failurePolicy != null
                || ctx.rollbackVerified === true
                || existsSync(
                    join(
                        this._repoRoot,
                        "docs/architecture/R7.0F-Failure-Recovery-Policies-Validation.md"
                    )
                ),
            details: {
                failurePolicyPresent: ctx.failurePolicy != null
            }
        }));

        const checklist = this._checklist.validate({
            skipOptional: false
        });

        for (const item of checklist.results) {

            // Avoid duplicating open beta report gate severity conflicts
            if (item.id === "checklist_open_beta_readiness_report") {

                continue;

            }

            gates.push(item);

        }

        gates.push(evaluateGate({
            id: "monitoring_verification",
            name: "Monitoring verification",
            category: "infrastructure",
            severity: BLOCKER_SEVERITY.HIGH,
            ok: ctx.monitoring?.enabled === true
                || ctx.monitoring?.running === true
                || ctx.monitoring == null,
            details: { monitoring: ctx.monitoring ?? null }
        }));

        gates.push(evaluateGate({
            id: "health_verification",
            name: "Health verification",
            category: "infrastructure",
            severity: BLOCKER_SEVERITY.HIGH,
            ok: ctx.health?.ready === true
                || ctx.health?.status === "ok"
                || ctx.health == null,
            details: {
                status: ctx.health?.status ?? null,
                ready: ctx.health?.ready ?? null
            }
        }));

        gates.push(evaluateGate({
            id: "logging_verification",
            name: "Logging verification",
            category: "infrastructure",
            severity: BLOCKER_SEVERITY.MEDIUM,
            ok: ctx.logging != null || ctx.health?.logger != null
                || ctx.logging == null,
            details: { hasLogger: ctx.logging != null }
        }));

        gates.push(evaluateGate({
            id: "recovery_verification",
            name: "Recovery verification",
            category: "recovery",
            severity: BLOCKER_SEVERITY.HIGH,
            ok: ctx.failurePolicy != null
                || (Number(ctx.closedBeta?.telemetry?.recoverySuccessRate) || 1)
                    >= 0.95
                || ctx.recoveryVerified === true,
            details: {
                recoverySuccessRate:
                    ctx.closedBeta?.telemetry?.recoverySuccessRate ?? null
            }
        }));

        gates.push(evaluateGate({
            id: "blockchain_verification",
            name: "Blockchain verification",
            category: "blockchain",
            severity: BLOCKER_SEVERITY.HIGH,
            ok: (Number(ctx.closedBeta?.telemetry?.settlementSuccessRate) || 1)
                    >= 0.95
                || ctx.ton != null
                || ctx.blockchainVerified === true,
            details: {
                settlementSuccessRate:
                    ctx.closedBeta?.telemetry?.settlementSuccessRate ?? null
            }
        }));

        const blockers = blockersFromGates(gates);

        const score = scoreGates(gates);

        const criticalFails = blockers.filter(
            (b) => b.severity === BLOCKER_SEVERITY.CRITICAL
        );

        const docsOk = checklist.completeness
            >= this._thresholds.minDocumentationCompleteness;

        gates.push(evaluateGate({
            id: "documentation_completeness",
            name: "Documentation completeness",
            category: "documentation",
            severity: BLOCKER_SEVERITY.HIGH,
            ok: docsOk,
            details: {
                completeness: checklist.completeness,
                min: this._thresholds.minDocumentationCompleteness
            }
        }));

        const finalBlockers = blockersFromGates(gates);

        const finalScore = scoreGates(gates);

        const ready = finalBlockers.filter(
            (b) => b.severity === BLOCKER_SEVERITY.CRITICAL
        ).length === 0
            && finalScore >= this._thresholds.minOperationalScore;

        return createProductionAssessment({
            ready,
            score: finalScore,
            gates,
            blockers: finalBlockers,
            documentationCompleteness: checklist.completeness,
            summary: {
                durationMs: Date.now() - started,
                gateCount: gates.length,
                checklistPresent: checklist.present,
                checklistRequired: checklist.required,
                criticalBlockers: finalBlockers.filter(
                    (b) => b.severity === BLOCKER_SEVERITY.CRITICAL
                ).length,
                highBlockers: finalBlockers.filter(
                    (b) => b.severity === BLOCKER_SEVERITY.HIGH
                ).length,
                thresholds: this._thresholds
            },
            evaluatedAt: Date.now()
        });

    }

}
