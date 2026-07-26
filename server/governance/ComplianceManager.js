/**
 * R9.0C — Compliance validation against governance policies.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { COMPLIANCE_STATUS } from "./GovernanceConfiguration.js";
import { createComplianceResult } from "./models/ComplianceResult.js";

function result({ id, name, policyId, ok, warn = false, details = {}, recommendations = [] }) {

    let status = COMPLIANCE_STATUS.FAILED;

    if (ok === true) {

        status = warn ? COMPLIANCE_STATUS.WARNING : COMPLIANCE_STATUS.PASSED;

    }

    return createComplianceResult({
        id,
        name,
        policyId,
        status,
        details,
        recommendations: ok
            ? recommendations
            : (recommendations.length
                ? recommendations
                : [`Resolve compliance item ${id}`])
    });

}

export class ComplianceManager {

    /**
     * @param {{ repoRoot?: string, required?: boolean }} [options]
     */
    constructor(options = {}) {

        this._repoRoot = options.repoRoot ?? null;

        this._required = options.required !== false;

        this._latest = null;

    }

    /**
     * @param {{
     *   policies?: object[],
     *   audit?: object|null,
     *   ctx?: object
     * }} input
     */
    evaluate(input = {}) {

        const ctx = input.ctx ?? {};

        const audit = input.audit ?? {};

        const policies = input.policies ?? [];

        const items = [];

        const healthOk = ctx.health?.ready === true
            || ctx.health?.status === "ok"
            || ctx.health == null;

        items.push(result({
            id: "operational-readiness",
            name: "Operational readiness",
            policyId: "operational-readiness",
            ok: healthOk && (ctx.operations?.enabled !== false),
            details: {
                healthReady: ctx.health?.ready ?? null,
                operationsLifecycle: ctx.operations?.lifecycle ?? null
            }
        }));

        const certOk = ["PASSED", "PASSED_WITH_WARNINGS"]
            .includes(ctx.certification?.status)
            || ctx.certification?.betaReady === true
            || ctx.certification == null;

        items.push(result({
            id: "release-governance",
            name: "Release governance",
            policyId: "release-governance",
            ok: certOk && (
                Boolean(ctx.release?.version)
                || ctx.release == null
            ),
            warn: ctx.certification?.status === "PASSED_WITH_WARNINGS",
            details: {
                certification: ctx.certification?.status ?? null,
                releaseVersion: ctx.release?.version ?? null
            }
        }));

        items.push(result({
            id: "configuration-consistency",
            name: "Configuration consistency",
            policyId: "configuration-consistency",
            ok: ctx.safeConfiguration != null
                || ctx.configurationPresent === true,
            details: {
                present: ctx.safeConfiguration != null
            }
        }));

        items.push(result({
            id: "monitoring-completeness",
            name: "Monitoring completeness",
            policyId: "monitoring-completeness",
            ok: ctx.monitoring?.enabled === true
                || ctx.monitoring?.running === true
                || ctx.monitoring == null,
            details: { enabled: ctx.monitoring?.enabled ?? null }
        }));

        items.push(result({
            id: "evidence-completeness",
            name: "Evidence completeness",
            policyId: "evidence-completeness",
            ok: (audit.evidence?.length ?? 0) > 0
                || (audit.passed ?? 0) > 0
                || ctx.evidencePresent === true,
            details: {
                auditEvidence: audit.evidence?.length ?? 0,
                auditScore: audit.score ?? null
            }
        }));

        items.push(result({
            id: "recovery-readiness",
            name: "Recovery readiness",
            policyId: "recovery-readiness",
            ok: ctx.failurePolicy != null
                || ctx.recoveryAvailable !== false,
            details: {
                failurePolicyPresent: ctx.failurePolicy != null
            }
        }));

        const profile = ctx.safeConfiguration?.deployment?.profile
            ?? ctx.deployment?.profile
            ?? null;

        const debugRisk = profile === "production"
            && ctx.debugEnabled === true;

        items.push(result({
            id: "security-checklist",
            name: "Security checklist",
            policyId: "security-checklist",
            ok: !debugRisk,
            details: { profile, debugEnabled: ctx.debugEnabled === true }
        }));

        const docsOk = this._repoRoot
            ? (
                existsSync(join(
                    this._repoRoot,
                    "docs/release/R9.0A-General-Availability-Release-Report.md"
                ))
                || existsSync(join(
                    this._repoRoot,
                    "docs/architecture/R9.0B-Post-Launch-Operations-Validation.md"
                ))
                || ctx.documentationPresent === true
            )
            : (ctx.documentationPresent !== false);

        items.push(result({
            id: "documentation-completeness",
            name: "Documentation completeness",
            policyId: "documentation-completeness",
            ok: docsOk,
            details: { repoRootPresent: this._repoRoot != null }
        }));

        // Ensure each loaded approved policy is represented
        for (const policy of policies) {

            if (items.some((i) => i.policyId === policy.id)) {

                continue;

            }

            items.push(result({
                id: `policy-${policy.id}`,
                name: policy.description || policy.id,
                policyId: policy.id,
                ok: true,
                details: { note: "No dedicated checker; acknowledged" }
            }));

        }

        const passed = items.filter(
            (i) => i.status === COMPLIANCE_STATUS.PASSED
        ).length;

        const warned = items.filter(
            (i) => i.status === COMPLIANCE_STATUS.WARNING
        ).length;

        const failed = items.filter(
            (i) => i.status === COMPLIANCE_STATUS.FAILED
        ).length;

        const score = items.length > 0
            ? Math.round((100 * (passed + warned * 0.5)) / items.length)
            : 0;

        this._latest = Object.freeze({
            evaluatedAt: Date.now(),
            results: Object.freeze(items),
            passed,
            warned,
            failed,
            score,
            compliant: this._required ? failed === 0 : failed === 0
        });

        return this._latest;

    }

    getLatest() {

        return this._latest;

    }

}
