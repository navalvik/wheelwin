/**
 * R9.0C — Platform governance coordinator (observational only).
 *
 * Does not mutate gameplay, networking, blockchain, release, operations,
 * launch orchestration, or monitoring engines.
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
    GOVERNANCE_LIFECYCLE,
    GOVERNANCE_LIFECYCLE_ORDER,
    DECISION_STATUS,
    resolveGovernanceConfig
} from "./GovernanceConfiguration.js";
import { createGovernanceState } from "./models/GovernanceState.js";
import { createGovernanceDecision } from "./models/GovernanceDecision.js";
import { OperationalAuditManager } from "./OperationalAuditManager.js";
import { ComplianceManager } from "./ComplianceManager.js";
import { GovernancePolicyManager } from "./GovernancePolicyManager.js";
import { ChangeGovernanceManager } from "./ChangeGovernanceManager.js";
import { RiskAssessmentManager } from "./RiskAssessmentManager.js";
import { EvidenceArchiveManager } from "./EvidenceArchiveManager.js";
import { AuditTrailManager } from "./AuditTrailManager.js";
import { PlatformReviewManager } from "./PlatformReviewManager.js";
import { GovernanceMetricsCollector } from "./GovernanceMetricsCollector.js";
import { GovernanceReportBuilder } from "./GovernanceReportBuilder.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function lifecycleIndex(state) {

    return GOVERNANCE_LIFECYCLE_ORDER.indexOf(state);

}

export class GovernanceManager {

    static _instance = null;

    constructor() {

        this._config = resolveGovernanceConfig();

        this._repoRoot = resolve(__dirname, "../..");

        this._providers = null;

        this._state = createGovernanceState({
            lifecycle: GOVERNANCE_LIFECYCLE.PLATFORM_ACTIVE,
            cycle: 0
        });

        this._policies = new GovernancePolicyManager();

        this._audit = new OperationalAuditManager();

        this._compliance = new ComplianceManager({
            repoRoot: this._repoRoot,
            required: this._config.complianceRequired
        });

        this._changes = new ChangeGovernanceManager();

        this._risk = new RiskAssessmentManager();

        this._archive = new EvidenceArchiveManager({
            retentionDays: this._config.evidenceRetentionDays,
            maxEntries: this._config.maxArchiveEntries
        });

        this._trail = new AuditTrailManager({
            maxEntries: this._config.maxTrailEntries
        });

        this._reviews = new PlatformReviewManager();

        this._metrics = new GovernanceMetricsCollector();

        this._reportBuilder = new GovernanceReportBuilder();

        this._lastAudit = null;

        this._lastCompliance = null;

        this._lastRisk = null;

        this._lastReview = null;

        this._lastDecision = null;

        this._lastSnapshot = null;

        this._startedAt = null;

        this._transitionLog = [];

    }

    static getInstance() {

        if (!GovernanceManager._instance) {

            GovernanceManager._instance = new GovernanceManager();

        }

        return GovernanceManager._instance;

    }

    static resetForTests() {

        GovernanceManager._instance = null;

    }

    /**
     * @param {{
     *   repoRoot?: string,
     *   config?: object,
     *   providers?: object
     * }} options
     */
    initialize(options = {}) {

        if (options.repoRoot) {

            this._repoRoot = options.repoRoot;

        }

        if (options.config) {

            this._config = Object.freeze({
                ...this._config,
                ...options.config
            });

        }

        this._providers = options.providers ?? null;

        this._compliance = new ComplianceManager({
            repoRoot: this._repoRoot,
            required: this._config.complianceRequired
        });

        this._archive = new EvidenceArchiveManager({
            retentionDays: this._config.evidenceRetentionDays,
            maxEntries: this._config.maxArchiveEntries
        });

        this._policies.loadDefaults();

        this._state = createGovernanceState({
            lifecycle: GOVERNANCE_LIFECYCLE.PLATFORM_ACTIVE,
            cycle: 0
        });

        this._startedAt = Date.now();

        this._trail.append({
            type: "initialize",
            summary: "Governance framework initialized",
            details: {
                policies: this._policies.summary().total
            }
        });

        return this;

    }

    updateProviders(providers = {}) {

        this._providers = {
            ...(this._providers ?? {}),
            ...providers
        };

        return this;

    }

    getLifecycle() {

        return this._state.lifecycle;

    }

    getConfig() {

        return this._config;

    }

    getPolicyManager() {

        return this._policies;

    }

    getAuditManager() {

        return this._audit;

    }

    getComplianceManager() {

        return this._compliance;

    }

    getRiskManager() {

        return this._risk;

    }

    getChangeManager() {

        return this._changes;

    }

    getArchiveManager() {

        return this._archive;

    }

    getTrailManager() {

        return this._trail;

    }

    getReviewManager() {

        return this._reviews;

    }

    /**
     * @param {string} next
     * @param {{ force?: boolean, notes?: string }} [opts]
     */
    transitionTo(next, opts = {}) {

        const target = GOVERNANCE_LIFECYCLE[next] ?? next;

        if (!Object.values(GOVERNANCE_LIFECYCLE).includes(target)) {

            throw new Error(`Unknown governance lifecycle: ${next}`);

        }

        const current = this._state.lifecycle;

        if (target === current) {

            return current;

        }

        // NEXT_AUDIT_CYCLE loops back to PLATFORM_ACTIVE / AUDIT_WINDOW
        if (
            current === GOVERNANCE_LIFECYCLE.NEXT_AUDIT_CYCLE
            && target === GOVERNANCE_LIFECYCLE.PLATFORM_ACTIVE
        ) {

            this._applyTransition(current, target, opts.notes);

            return this._state.lifecycle;

        }

        if (
            current === GOVERNANCE_LIFECYCLE.NEXT_AUDIT_CYCLE
            && target === GOVERNANCE_LIFECYCLE.AUDIT_WINDOW
        ) {

            this._applyTransition(current, target, opts.notes);

            return this._state.lifecycle;

        }

        if (
            current === GOVERNANCE_LIFECYCLE.GOVERNANCE_APPROVED
            && target === GOVERNANCE_LIFECYCLE.PLATFORM_ACTIVE
            && opts.force
        ) {

            this._applyTransition(current, target, opts.notes);

            return this._state.lifecycle;

        }

        const fromIdx = lifecycleIndex(current);

        const toIdx = lifecycleIndex(target);

        if (!opts.force && toIdx !== fromIdx + 1) {

            throw new Error(
                `Invalid governance transition ${current} → ${target}`
            );

        }

        this._applyTransition(current, target, opts.notes);

        return this._state.lifecycle;

    }

    /**
     * Full governance cycle: audit → compliance → risk → review → decision.
     *
     * @param {{
     *   autoAdvanceLifecycle?: boolean,
     *   overrides?: object
     * }} [opts]
     */
    runCycle(opts = {}) {

        const auto = opts.autoAdvanceLifecycle !== false;

        if (auto) {

            if (this.getLifecycle() === GOVERNANCE_LIFECYCLE.PLATFORM_ACTIVE
                || this.getLifecycle() === GOVERNANCE_LIFECYCLE.NEXT_AUDIT_CYCLE) {

                if (this.getLifecycle() === GOVERNANCE_LIFECYCLE.NEXT_AUDIT_CYCLE) {

                    this.transitionTo(GOVERNANCE_LIFECYCLE.AUDIT_WINDOW, {
                        notes: "new cycle"
                    });

                } else {

                    this.transitionTo(GOVERNANCE_LIFECYCLE.AUDIT_WINDOW, {
                        notes: "runCycle"
                    });

                }

            }

        }

        const ctx = this._buildContext(opts.overrides ?? {});

        if (auto
            && this.getLifecycle() === GOVERNANCE_LIFECYCLE.AUDIT_WINDOW) {

            // stay during audit
        }

        const audit = this._audit.audit(ctx);

        this._lastAudit = audit;

        this._trail.append({
            type: "audit",
            summary: `Operational audit score ${audit.score}`,
            details: {
                passed: audit.passed,
                failed: audit.failed
            }
        });

        if (auto
            && this.getLifecycle() === GOVERNANCE_LIFECYCLE.AUDIT_WINDOW) {

            this.transitionTo(GOVERNANCE_LIFECYCLE.COMPLIANCE_VALIDATION);

        }

        const compliance = this._compliance.evaluate({
            policies: this._policies.list(),
            audit,
            ctx
        });

        this._lastCompliance = compliance;

        this._trail.append({
            type: "compliance",
            summary: `Compliance score ${compliance.score}`,
            details: {
                passed: compliance.passed,
                failed: compliance.failed
            }
        });

        if (auto
            && this.getLifecycle()
                === GOVERNANCE_LIFECYCLE.COMPLIANCE_VALIDATION) {

            this.transitionTo(GOVERNANCE_LIFECYCLE.RISK_REVIEW);

        }

        const risk = this._risk.assess({
            audit,
            compliance,
            ctx
        });

        this._lastRisk = risk;

        this._trail.append({
            type: "risk_review",
            summary: `Risk score ${risk.score}`,
            details: {
                critical: risk.critical,
                high: risk.high
            }
        });

        if (auto
            && this.getLifecycle() === GOVERNANCE_LIFECYCLE.RISK_REVIEW) {

            this.transitionTo(GOVERNANCE_LIFECYCLE.PLATFORM_REVIEW);

        }

        const review = this._reviews.review({
            audit,
            compliance,
            risk,
            ctx
        });

        this._lastReview = review;

        this._trail.append({
            type: "platform_review",
            summary: `Platform review score ${review.score}`,
            refs: { reviewId: review.id }
        });

        const archive = this._archive.archive({
            label: `cycle-${this._state.cycle + 1}`,
            auditRefs: audit.records.map((r) => r.id),
            complianceRefs: compliance.results.map((r) => r.id),
            operationalRefs: {
                operationsScore: ctx.operations?.operationalScore ?? null,
                lifecycle: ctx.operations?.lifecycle ?? null
            },
            reviewRefs: [review.id],
            evidenceItems: audit.evidence
        });

        this._trail.append({
            type: "evidence_archive",
            summary: "Evidence archived",
            refs: { archiveId: archive.id, hash: archive.evidenceHash }
        });

        const decision = this._decide({
            audit,
            compliance,
            risk,
            review,
            evidenceHash: archive.evidenceHash
        });

        this._lastDecision = decision;

        this._trail.append({
            type: "governance_decision",
            summary: `Decision ${decision.status}`,
            details: { reason: decision.reason, score: decision.score }
        });

        if (auto
            && this.getLifecycle() === GOVERNANCE_LIFECYCLE.PLATFORM_REVIEW) {

            if (decision.status === DECISION_STATUS.APPROVED
                || decision.status === DECISION_STATUS.CONDITIONAL) {

                this.transitionTo(GOVERNANCE_LIFECYCLE.GOVERNANCE_APPROVED, {
                    notes: decision.status
                });

                this.transitionTo(GOVERNANCE_LIFECYCLE.NEXT_AUDIT_CYCLE, {
                    notes: "cycle complete"
                });

                this._state = createGovernanceState({
                    lifecycle: GOVERNANCE_LIFECYCLE.NEXT_AUDIT_CYCLE,
                    cycle: this._state.cycle + 1,
                    notes: "awaiting next audit"
                });

            }

        }

        const governanceScore = Math.round(
            (
                (audit.score ?? 0)
                + (compliance.score ?? 0)
                + (risk.score ?? 0)
                + (review.score ?? 0)
            ) / 4
        );

        const metrics = this._metrics.collect({
            lifecycle: this.getLifecycle(),
            governanceScore,
            auditScore: audit.score,
            complianceScore: compliance.score,
            riskScore: risk.score,
            reviewScore: review.score,
            policyCount: this._policies.summary().total,
            archiveCount: this._archive.count(),
            trailCount: this._trail.count(),
            decisionStatus: decision.status
        });

        this._lastSnapshot = Object.freeze({
            collectedAt: Date.now(),
            lifecycle: this.getLifecycle(),
            cycle: this._state.cycle,
            audit,
            compliance,
            risk,
            review,
            decision,
            archive: this._archive.summary(),
            policies: this._policies.summary(),
            trail: this._trail.summary(),
            changes: this._changes.summary(),
            governanceScore,
            metrics
        });

        return this._lastSnapshot;

    }

    /**
     * @param {{ write?: boolean, reportPath?: string, overrides?: object }} [opts]
     */
    generateReport(opts = {}) {

        const snapshot = this._lastSnapshot
            ?? this.runCycle({
                autoAdvanceLifecycle: true,
                overrides: opts.overrides
            });

        const recommendations = [
            ...(snapshot.review?.recommendations ?? [])
        ];

        if ((snapshot.compliance?.failed ?? 0) > 0) {

            recommendations.push(
                "Prioritize FAILED compliance items for remediation tracking."
            );

        }

        const input = {
            lifecycle: snapshot.lifecycle,
            cycle: snapshot.cycle,
            governanceScore: snapshot.governanceScore,
            audit: snapshot.audit,
            compliance: snapshot.compliance,
            risk: snapshot.risk,
            policies: snapshot.policies,
            archive: snapshot.archive,
            review: snapshot.review,
            decision: snapshot.decision,
            recommendations: [...new Set(recommendations)]
        };

        const markdown = this._reportBuilder.buildMarkdown(input);

        let path = null;

        if (opts.write !== false) {

            path = opts.reportPath
                ?? resolve(this._repoRoot, this._config.reportRelativePath);

            this._reportBuilder.writeReport(path, input);

        }

        return Object.freeze({ path, markdown, ...input, snapshot });

    }

    getSafeStatus() {

        if (!this._lastSnapshot && this._config.enabled !== false) {

            this.runCycle({ autoAdvanceLifecycle: false });

        }

        const snap = this._lastSnapshot;

        return Object.freeze({
            enabled: this._config.enabled === true,
            lifecycle: this.getLifecycle(),
            cycle: this._state.cycle,
            governanceScore: snap?.governanceScore ?? 0,
            auditScore: snap?.audit?.score ?? 0,
            complianceScore: snap?.compliance?.score ?? 0,
            complianceFailed: snap?.compliance?.failed ?? 0,
            riskScore: snap?.risk?.score ?? 0,
            riskCritical: snap?.risk?.critical ?? 0,
            reviewScore: snap?.review?.score ?? 0,
            decisionStatus: snap?.decision?.status ?? null,
            policyStatus: snap?.policies
                ? Object.freeze({
                    total: snap.policies.total,
                    approved: snap.policies.approved
                })
                : null,
            archiveCount: snap?.archive?.total ?? 0,
            trailCount: snap?.trail?.total ?? 0,
            lastAuditAt: snap?.audit?.auditedAt ?? null,
            lastReviewAt: snap?.review?.timestamp ?? null,
            evidenceHash: snap?.archive?.latestHash
                ? String(snap.archive.latestHash).slice(0, 16)
                : null,
            startedAt: this._startedAt
        });

    }

    getConsoleProjection() {

        const status = this.getSafeStatus();

        const snap = this._lastSnapshot;

        return Object.freeze({
            ...status,
            complianceResults: (snap?.compliance?.results ?? [])
                .slice(0, 20)
                .map((r) => Object.freeze({
                    id: r.id,
                    status: r.status,
                    policyId: r.policyId
                })),
            risks: (snap?.risk?.risks ?? []).slice(0, 20).map((r) =>
                Object.freeze({
                    id: r.id,
                    category: r.category,
                    severity: r.severity,
                    score: r.score
                })),
            auditDomains: (snap?.audit?.records ?? []).map((r) =>
                Object.freeze({
                    domain: r.domain,
                    status: r.status
                })),
            trailRecent: this._trail.list().slice(0, 15).map((e) =>
                Object.freeze({
                    type: e.type,
                    summary: e.summary,
                    timestamp: e.timestamp
                })),
            policies: this._policies.list().map((p) => Object.freeze({
                id: p.id,
                version: p.version,
                approvalStatus: p.approvalStatus
            }))
        });

    }

    _decide({ audit, compliance, risk, review, evidenceHash }) {

        let status = DECISION_STATUS.APPROVED;

        let reason = "Governance cycle approved";

        if ((compliance.failed ?? 0) > 0 && this._config.complianceRequired) {

            status = DECISION_STATUS.REJECTED;

            reason = `${compliance.failed} required compliance failure(s)`;

        } else if ((risk.critical ?? 0) > 0) {

            status = DECISION_STATUS.REJECTED;

            reason = `${risk.critical} CRITICAL risk(s) present`;

        } else if ((compliance.failed ?? 0) > 0
            || (risk.high ?? 0) > 0
            || (audit.failed ?? 0) > 0) {

            status = DECISION_STATUS.CONDITIONAL;

            reason = "Conditional approval with outstanding warnings/failures";

        }

        const score = Math.round(
            (
                (audit.score ?? 0)
                + (compliance.score ?? 0)
                + (risk.score ?? 0)
                + (review.score ?? 0)
            ) / 4
        );

        return createGovernanceDecision({
            status,
            score,
            reason,
            evidenceHash
        });

    }

    _applyTransition(from, to, notes) {

        this._transitionLog.push(Object.freeze({
            at: Date.now(),
            from,
            to,
            notes: notes ? String(notes).slice(0, 200) : null
        }));

        this._state = createGovernanceState({
            lifecycle: to,
            cycle: this._state.cycle,
            notes: notes ?? null
        });

        this._trail.append({
            type: "lifecycle",
            summary: `${from} → ${to}`,
            details: { notes: notes ?? null }
        });

    }

    _buildContext(overrides = {}) {

        const p = this._providers ?? {};

        return {
            health: overrides.health
                ?? p.healthSnapshot?.()
                ?? null,
            monitoring: overrides.monitoring
                ?? p.monitoringManager?.getHealthStatus?.()
                ?? null,
            operations: overrides.operations
                ?? p.operationsManager?.getSafeStatus?.()
                ?? null,
            release: overrides.release
                ?? p.releaseManager?.getSafeStatus?.()
                ?? null,
            certification: overrides.certification
                ?? p.certificationManager?.getSafeStatus?.()
                ?? null,
            deployment: overrides.deployment
                ?? p.deploymentHealth?.()
                ?? null,
            ga: overrides.ga
                ?? p.generalAvailabilityManager?.getSafeStatus?.()
                ?? null,
            closedBeta: overrides.closedBeta
                ?? p.closedBetaManager?.getSafeStatus?.()
                ?? null,
            failurePolicy: overrides.failurePolicy
                ?? p.failurePolicy?.()
                ?? null,
            ton: overrides.ton
                ?? p.tonConfig?.()
                ?? null,
            safeConfiguration: overrides.safeConfiguration
                ?? p.safeConfiguration?.()
                ?? null,
            developerConsole: overrides.developerConsole
                ?? p.developerConsole?.()
                ?? null,
            ...overrides
        };

    }

}

export {
    GOVERNANCE_LIFECYCLE,
    DECISION_STATUS,
    resolveGovernanceConfig
};
