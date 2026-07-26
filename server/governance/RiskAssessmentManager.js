/**
 * R9.0C — Observational operational risk assessment.
 */

import {
    RISK_SEVERITY,
    RISK_CATEGORY
} from "./GovernanceConfiguration.js";
import { createRiskAssessment } from "./models/RiskAssessment.js";

function severityFromScore(score) {

    if (score >= 80) {

        return RISK_SEVERITY.CRITICAL;

    }

    if (score >= 60) {

        return RISK_SEVERITY.HIGH;

    }

    if (score >= 35) {

        return RISK_SEVERITY.MEDIUM;

    }

    return RISK_SEVERITY.LOW;

}

export class RiskAssessmentManager {

    constructor() {

        this._latest = null;

    }

    /**
     * @param {{
     *   audit?: object|null,
     *   compliance?: object|null,
     *   ctx?: object
     * }} input
     */
    assess(input = {}) {

        const ctx = input.ctx ?? {};

        const audit = input.audit ?? {};

        const compliance = input.compliance ?? {};

        const risks = [];

        const push = (id, category, score, summary, details = {}, recommendations = []) => {

            risks.push(createRiskAssessment({
                id,
                category,
                severity: severityFromScore(score),
                score,
                summary,
                details,
                recommendations
            }));

        };

        const auditFail = audit.failed ?? 0;

        push(
            "operational-audit",
            RISK_CATEGORY.OPERATIONAL,
            Math.min(100, auditFail * 25),
            auditFail > 0
                ? `${auditFail} audit domain(s) failed`
                : "Operational audit domains healthy",
            { failed: auditFail, score: audit.score ?? null }
        );

        const complianceFail = compliance.failed ?? 0;

        push(
            "compliance",
            RISK_CATEGORY.GOVERNANCE,
            Math.min(100, complianceFail * 30),
            complianceFail > 0
                ? `${complianceFail} compliance item(s) failed`
                : "Compliance targets met",
            { failed: complianceFail, score: compliance.score ?? null }
        );

        const healthBad = ctx.health?.ready === false
            || ctx.health?.status === "not_ready";

        push(
            "infrastructure-health",
            RISK_CATEGORY.INFRASTRUCTURE,
            healthBad ? 70 : (ctx.health?.status === "degraded" ? 40 : 5),
            healthBad
                ? "Health not ready"
                : "Infrastructure health acceptable",
            { status: ctx.health?.status ?? null }
        );

        const certBad = ctx.certification?.status === "FAILED";

        push(
            "release",
            RISK_CATEGORY.RELEASE,
            certBad ? 75 : 10,
            certBad
                ? "Certification failed"
                : "Release governance acceptable",
            { status: ctx.certification?.status ?? null }
        );

        const settlement = Number(
            ctx.operations?.kpiSummary?.settlementSuccessRate
            ?? ctx.closedBeta?.telemetry?.settlementSuccessRate
        );

        push(
            "payment-settlement",
            RISK_CATEGORY.PAYMENT,
            Number.isFinite(settlement) && settlement < 0.9 ? 65 : 10,
            "Payment/settlement risk assessment",
            { settlementSuccessRate: Number.isFinite(settlement) ? settlement : null }
        );

        push(
            "recovery",
            RISK_CATEGORY.RECOVERY,
            ctx.failurePolicy == null && ctx.recoveryAvailable === false
                ? 60
                : 10,
            "Recovery readiness risk",
            { failurePolicyPresent: ctx.failurePolicy != null }
        );

        push(
            "monitoring",
            RISK_CATEGORY.MONITORING,
            ctx.monitoring?.enabled === false ? 55 : 8,
            "Monitoring continuity risk",
            { enabled: ctx.monitoring?.enabled ?? null }
        );

        const openCritical = Number(
            ctx.operations?.incidentSummary?.openCritical
            ?? ctx.closedBeta?.incidents?.openCritical
            ?? 0
        );

        push(
            "operational-incidents",
            RISK_CATEGORY.OPERATIONAL,
            Math.min(100, openCritical * 40),
            openCritical > 0
                ? `${openCritical} open CRITICAL incident(s)`
                : "No open CRITICAL incidents",
            { openCritical }
        );

        const critical = risks.filter(
            (r) => r.severity === RISK_SEVERITY.CRITICAL
        ).length;

        const high = risks.filter(
            (r) => r.severity === RISK_SEVERITY.HIGH
        ).length;

        const avg = risks.length > 0
            ? Math.round(
                risks.reduce((a, r) => a + r.score, 0) / risks.length
            )
            : 0;

        // Lower risk score is better for "riskScore" display inverted:
        // expose both rawRisk and riskScore (100 - avg)
        this._latest = Object.freeze({
            assessedAt: Date.now(),
            risks: Object.freeze(risks),
            critical,
            high,
            rawRisk: avg,
            score: Math.max(0, 100 - avg),
            highestSeverity: critical > 0
                ? RISK_SEVERITY.CRITICAL
                : (high > 0 ? RISK_SEVERITY.HIGH : RISK_SEVERITY.MEDIUM)
        });

        return this._latest;

    }

    getLatest() {

        return this._latest;

    }

}
