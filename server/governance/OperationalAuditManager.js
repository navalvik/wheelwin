/**
 * R9.0C — Read-only operational audit across platform domains.
 */

import { createAuditRecord } from "./models/AuditRecord.js";
import { createAuditEvidence } from "./models/AuditEvidence.js";

function auditDomain(domain, ok, details = {}, recommendations = []) {

    const started = Date.now();

    const status = ok === true ? "PASS" : (ok === "warn" ? "WARN" : "FAIL");

    return createAuditRecord({
        domain,
        status,
        durationMs: Math.max(0, Date.now() - started),
        details,
        recommendations: ok === true
            ? recommendations
            : (recommendations.length
                ? recommendations
                : [`Review ${domain} domain`])
    });

}

export class OperationalAuditManager {

    constructor() {

        /** @type {ReturnType<typeof createAuditRecord>[]} */
        this._lastRecords = [];

        /** @type {ReturnType<typeof createAuditEvidence>[]} */
        this._lastEvidence = [];

    }

    /**
     * @param {object} ctx read-only provider bag
     */
    audit(ctx = {}) {

        const records = [];

        const health = ctx.health ?? {};

        const monitoring = ctx.monitoring ?? {};

        const operations = ctx.operations ?? {};

        const release = ctx.release ?? {};

        const deployment = ctx.deployment ?? {};

        const certification = ctx.certification ?? {};

        const ga = ctx.ga ?? {};

        const failurePolicy = ctx.failurePolicy ?? null;

        const ton = ctx.ton ?? {};

        const config = ctx.safeConfiguration ?? null;

        records.push(auditDomain(
            "health",
            health.ready === true
                || health.status === "ok"
                || health.status === "degraded"
                || ctx.health == null,
            {
                status: health.status ?? null,
                ready: health.ready ?? null
            }
        ));

        records.push(auditDomain(
            "monitoring",
            monitoring.enabled === true
                || monitoring.running === true
                || ctx.monitoring == null,
            { enabled: monitoring.enabled ?? null }
        ));

        records.push(auditDomain(
            "operations",
            operations.enabled !== false
                || operations.lifecycle != null
                || ctx.operations == null,
            {
                lifecycle: operations.lifecycle ?? null,
                score: operations.operationalScore ?? null
            }
        ));

        records.push(auditDomain(
            "releases",
            Boolean(release.version)
                || release.status === "built"
                || ctx.release == null,
            {
                version: release.version ?? null,
                status: release.status ?? null
            }
        ));

        records.push(auditDomain(
            "deployments",
            deployment.ready === true
                || deployment.overall === "ok"
                || deployment.profile != null
                || ctx.deployment == null,
            {
                profile: deployment.profile ?? null,
                overall: deployment.overall ?? null
            }
        ));

        records.push(auditDomain(
            "recovery",
            failurePolicy != null || ctx.recoveryAvailable !== false,
            { failurePolicyPresent: failurePolicy != null }
        ));

        records.push(auditDomain(
            "payments",
            ctx.paymentAvailable !== false,
            {
                settlementSuccessRate:
                    operations.kpiSummary?.settlementSuccessRate
                    ?? ctx.closedBeta?.telemetry?.settlementSuccessRate
                    ?? null
            }
        ));

        records.push(auditDomain(
            "settlement",
            ctx.settlementAvailable !== false,
            {
                available: ctx.settlementAvailable !== false
            }
        ));

        records.push(auditDomain(
            "blockchain",
            ton.network != null
                || ctx.blockchainConnected === true
                || ctx.ton == null,
            { network: ton.network ?? null }
        ));

        records.push(auditDomain(
            "configuration",
            config != null || ctx.configurationPresent === true,
            {
                profile: config?.deployment?.profile
                    ?? config?.profile
                    ?? null
            }
        ));

        records.push(auditDomain(
            "developer_console",
            ctx.developerConsole?.enabled === true
                || ctx.developerConsole == null,
            { enabled: ctx.developerConsole?.enabled ?? null }
        ));

        records.push(auditDomain(
            "certification",
            ["PASSED", "PASSED_WITH_WARNINGS"].includes(certification.status)
                || certification.betaReady === true
                || ctx.certification == null,
            { status: certification.status ?? null },
            certification.status === "PASSED_WITH_WARNINGS"
                ? ["Review certification warnings"]
                : []
        ));

        records.push(auditDomain(
            "ga",
            ga.lifecycle != null || ctx.ga == null,
            {
                lifecycle: ga.lifecycle ?? null,
                rollbackRecommended: ga.rollbackRecommended === true
            }
        ));

        const evidence = records.map((r) => createAuditEvidence({
            source: `audit.${r.domain}`,
            status: r.status,
            details: {
                domain: r.domain,
                ...r.details
            },
            recommendations: [...r.recommendations]
        }));

        this._lastRecords = records;

        this._lastEvidence = evidence;

        const passed = records.filter((r) => r.status === "PASS").length;

        const warned = records.filter((r) => r.status === "WARN").length;

        const failed = records.filter((r) => r.status === "FAIL").length;

        return Object.freeze({
            auditedAt: Date.now(),
            records: Object.freeze(records),
            evidence: Object.freeze(evidence),
            passed,
            warned,
            failed,
            score: records.length > 0
                ? Math.round((100 * (passed + warned * 0.5)) / records.length)
                : 0
        });

    }

    getLast() {

        return Object.freeze({
            records: Object.freeze([...(this._lastRecords ?? [])]),
            evidence: Object.freeze([...(this._lastEvidence ?? [])])
        });

    }

}
