/**
 * R9.0C — Platform governance tests.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
    GovernanceManager,
    GOVERNANCE_LIFECYCLE
} from "../governance/GovernanceManager.js";
import { OperationalAuditManager } from "../governance/OperationalAuditManager.js";
import { ComplianceManager } from "../governance/ComplianceManager.js";
import { RiskAssessmentManager } from "../governance/RiskAssessmentManager.js";
import { GovernancePolicyManager } from "../governance/GovernancePolicyManager.js";
import { EvidenceArchiveManager } from "../governance/EvidenceArchiveManager.js";
import { AuditTrailManager } from "../governance/AuditTrailManager.js";
import { PlatformReviewManager } from "../governance/PlatformReviewManager.js";
import { ChangeGovernanceManager } from "../governance/ChangeGovernanceManager.js";
import {
    hashEvidencePayload,
    createAuditEvidence
} from "../governance/models/AuditEvidence.js";
import { COMPLIANCE_STATUS, RISK_SEVERITY } from "../governance/GovernanceConfiguration.js";
import { HealthService } from "../services/HealthService.js";
import { MonitoringManager } from "../monitoring/MonitoringManager.js";
import { buildServerOverview } from "../console/projectionBuilders/buildServerOverview.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const repoRoot = resolve(__dirname, "../..");

function healthyProviders() {

    return {
        monitoringManager: {
            getHealthStatus: () => ({ enabled: true, running: true })
        },
        healthSnapshot: () => ({ status: "ok", ready: true }),
        deploymentHealth: () => ({ overall: "ok", ready: true }),
        operationsManager: {
            getSafeStatus: () => ({
                enabled: true,
                lifecycle: "NORMAL_OPERATION",
                operationalScore: 95
            })
        },
        releaseManager: {
            getSafeStatus: () => ({ version: "1.0.0" })
        },
        certificationManager: {
            getSafeStatus: () => ({ status: "PASSED", betaReady: true })
        },
        generalAvailabilityManager: {
            getSafeStatus: () => ({ lifecycle: "STABLE_RELEASE" })
        },
        failurePolicy: () => ({ enabled: true }),
        safeConfiguration: () => ({
            profile: "development",
            deployment: { profile: "development" }
        }),
        developerConsole: () => ({ enabled: true }),
        tonConfig: () => ({ network: "testnet" })
    };

}

async function main() {

    // --- GovernanceManager lifecycle ---

    {
        GovernanceManager.resetForTests();

        const manager = GovernanceManager.getInstance();

        manager.initialize({
            repoRoot,
            config: { enabled: true, complianceRequired: true },
            providers: healthyProviders()
        });

        assert.equal(
            manager.getLifecycle(),
            GOVERNANCE_LIFECYCLE.PLATFORM_ACTIVE
        );

        manager.transitionTo(GOVERNANCE_LIFECYCLE.AUDIT_WINDOW);

        manager.transitionTo(GOVERNANCE_LIFECYCLE.COMPLIANCE_VALIDATION);

        manager.transitionTo(GOVERNANCE_LIFECYCLE.RISK_REVIEW);

        manager.transitionTo(GOVERNANCE_LIFECYCLE.PLATFORM_REVIEW);

        manager.transitionTo(GOVERNANCE_LIFECYCLE.GOVERNANCE_APPROVED);

        manager.transitionTo(GOVERNANCE_LIFECYCLE.NEXT_AUDIT_CYCLE);

        assert.throws(() =>
            manager.transitionTo(GOVERNANCE_LIFECYCLE.RISK_REVIEW)
        );

        console.log("  GovernanceManager lifecycle: OK");

        GovernanceManager.resetForTests();
    }

    // --- OperationalAuditManager ---

    {
        const auditMgr = new OperationalAuditManager();

        const audit = auditMgr.audit({
            health: { status: "ok", ready: true },
            monitoring: { enabled: true },
            operations: { enabled: true, lifecycle: "NORMAL_OPERATION" },
            release: { version: "1.0.0" },
            deployment: { overall: "ok" },
            failurePolicy: { enabled: true },
            safeConfiguration: { profile: "development" },
            developerConsole: { enabled: true },
            ton: { network: "testnet" }
        });

        assert.ok(audit.score >= 0);

        assert.ok(Array.isArray(audit.records));

        assert.ok(audit.evidence.length > 0);

        assert.ok(Object.isFrozen(audit.evidence[0]));

        console.log("  OperationalAuditManager: OK");
    }

    // --- ComplianceManager ---

    {
        const compliance = new ComplianceManager({
            repoRoot,
            required: true
        });

        const audit = new OperationalAuditManager().audit({
            health: { ready: true },
            monitoring: { enabled: true },
            operations: { enabled: true },
            evidencePresent: true
        });

        const result = compliance.evaluate({
            policies: new GovernancePolicyManager().loadDefaults(),
            audit,
            ctx: {
                health: { ready: true },
                operations: { enabled: true },
                monitoring: { enabled: true },
                certification: { status: "PASSED" },
                release: { version: "1.0.0" },
                safeConfiguration: { profile: "development" },
                failurePolicy: { enabled: true },
                documentationPresent: true
            }
        });

        assert.ok(result.score >= 0);

        assert.ok(result.results.every((r) =>
            Object.values(COMPLIANCE_STATUS).includes(r.status)
        ));

        const again = compliance.evaluate({
            policies: new GovernancePolicyManager().loadDefaults(),
            audit,
            ctx: {
                health: { ready: true },
                operations: { enabled: true },
                monitoring: { enabled: true },
                certification: { status: "PASSED" },
                release: { version: "1.0.0" },
                safeConfiguration: { profile: "development" },
                failurePolicy: { enabled: true },
                documentationPresent: true
            }
        });

        assert.equal(result.score, again.score);

        assert.equal(result.passed, again.passed);

        console.log("  ComplianceManager: OK");
    }

    // --- RiskAssessmentManager ---

    {
        const riskMgr = new RiskAssessmentManager();

        const assessment = riskMgr.assess({
            audit: { failed: 0, warned: 0, score: 100 },
            compliance: { failed: 0, warned: 0, score: 100 },
            ctx: {
                operations: { operationalScore: 95 },
                monitoring: { enabled: true }
            }
        });

        assert.ok(assessment.score >= 0);

        assert.ok(assessment.risks.every((r) =>
            Object.values(RISK_SEVERITY).includes(r.severity)
        ));

        assert.ok(Object.isFrozen(assessment));

        console.log("  RiskAssessmentManager: OK");
    }

    // --- PolicyManager ---

    {
        const policies = new GovernancePolicyManager();

        policies.loadDefaults();

        assert.ok(policies.summary().total >= 8);

        assert.ok(policies.summary().approved >= 1);

        const first = policies.list()[0];

        assert.ok(Object.isFrozen(first));

        console.log("  GovernancePolicyManager: OK");
    }

    // --- EvidenceArchiveManager immutability ---

    {
        const archive = new EvidenceArchiveManager({ retentionDays: 30 });

        const evidence = createAuditEvidence({
            source: "test",
            status: "OK",
            details: { a: 1 }
        });

        const entry = archive.archive({
            label: "unit",
            auditRefs: ["a1"],
            complianceRefs: ["c1"],
            evidenceItems: [evidence]
        });

        assert.ok(Object.isFrozen(entry));

        assert.equal(entry.evidenceHash.length, 64);

        const hash1 = hashEvidencePayload({
            label: "unit",
            auditRefs: ["a1"],
            complianceRefs: ["c1"],
            operationalRefs: {},
            reviewRefs: [],
            evidenceHashes: [evidence.evidenceHash]
        });

        const hash2 = hashEvidencePayload({
            label: "unit",
            auditRefs: ["a1"],
            complianceRefs: ["c1"],
            operationalRefs: {},
            reviewRefs: [],
            evidenceHashes: [evidence.evidenceHash]
        });

        assert.equal(hash1, hash2);

        console.log("  EvidenceArchiveManager: OK");
    }

    // --- AuditTrailManager ---

    {
        const trail = new AuditTrailManager();

        trail.append({ type: "audit", summary: "first" });

        trail.append({ type: "compliance", summary: "second" });

        assert.equal(trail.count(), 2);

        assert.ok(Object.isFrozen(trail.list()[0]));

        console.log("  AuditTrailManager: OK");
    }

    // --- PlatformReviewManager ---

    {
        const reviews = new PlatformReviewManager();

        const review = reviews.review({
            audit: { score: 90, passed: 8, failed: 0 },
            compliance: { score: 95, passed: 8, failed: 0 },
            risk: { score: 88, critical: 0, high: 0 },
            ctx: {
                operations: {
                    lifecycle: "NORMAL_OPERATION",
                    kpiSummary: { availability: 0.99 },
                    slaSummary: { score: 92 },
                    incidentSummary: { open: 0 },
                    maintenanceState: "idle"
                },
                release: { version: "1.0.0" }
            }
        });

        assert.ok(review.score >= 0);

        assert.ok(Array.isArray(review.recommendations));

        assert.ok(Object.isFrozen(review));

        console.log("  PlatformReviewManager: OK");
    }

    // --- ChangeGovernanceManager ---

    {
        const changes = new ChangeGovernanceManager();

        const proposed = changes.propose({
            title: "Policy review",
            category: "Governance"
        });

        assert.equal(proposed.status, "PROPOSED");

        changes.setStatus(proposed.id, "RECORDED");

        assert.equal(changes.list()[0].status, "RECORDED");

        console.log("  ChangeGovernanceManager: OK");
    }

    // --- Full cycle + health/monitoring/console ---

    {
        GovernanceManager.resetForTests();

        MonitoringManager.resetForTests();

        const manager = GovernanceManager.getInstance();

        manager.initialize({
            repoRoot,
            config: {
                enabled: true,
                complianceRequired: true
            },
            providers: healthyProviders()
        });

        const snap = manager.runCycle({
            autoAdvanceLifecycle: true,
            overrides: { documentationPresent: true }
        });

        assert.ok(snap.governanceScore >= 0);

        assert.ok(Object.isFrozen(snap));

        assert.equal(
            manager.getLifecycle(),
            GOVERNANCE_LIFECYCLE.NEXT_AUDIT_CYCLE
        );

        const status = manager.getSafeStatus();

        assert.equal(status.lifecycle, GOVERNANCE_LIFECYCLE.NEXT_AUDIT_CYCLE);

        const health = new HealthService({
            logger: { info() {}, warn() {}, error() {}, debug() {} },
            productionConfig: {}
        });

        health.setGovernanceStatus(status);

        const snapshot = health.getHealthSnapshot();

        assert.equal(
            snapshot.governance.lifecycle,
            GOVERNANCE_LIFECYCLE.NEXT_AUDIT_CYCLE
        );

        const overview = buildServerOverview({
            version: "1.0.0",
            startedAt: Date.now(),
            healthService: health,
            roomManager: { getRooms: () => [] },
            gameManager: { getGames: () => [] },
            playerManager: { getDebugSnapshot: () => ({ players: [] }) },
            setupSessionLifecycle: {
                getDebugSnapshot: () => ({ activeCount: 0 })
            },
            recoveryEngine: { listActiveRecoveryGameIds: () => [] },
            simulationLoop: { getActiveGameCount: () => 0 },
            socketGateway: { getConnectedSocketCount: () => 0 }
        });

        assert.equal(
            overview.governance.lifecycle,
            GOVERNANCE_LIFECYCLE.NEXT_AUDIT_CYCLE
        );

        const monitoring = MonitoringManager.getInstance();

        monitoring.initialize({
            enabled: true,
            intervals: { systemMs: 60_000 },
            providers: {
                governanceManager: manager
            }
        });

        await new Promise((r) => setTimeout(r, 20));

        assert.ok(monitoring.getSnapshot());

        const tmp = mkdtempSync(join(tmpdir(), "ww-gov-"));

        const reportPath = join(tmp, "gov-report.md");

        const report = manager.generateReport({
            write: true,
            reportPath
        });

        assert.ok(existsSync(reportPath));

        const md = readFileSync(reportPath, "utf8");

        assert.match(md, /Platform Governance Report/);

        assert.ok(report.governanceScore >= 0);

        rmSync(tmp, { recursive: true, force: true });

        console.log("  GovernanceManager + health/monitoring/console: OK");

        GovernanceManager.resetForTests();

        MonitoringManager.resetForTests();
    }

    console.log("governance.test.js: all passed");

}

main().catch((err) => {

    console.error(err);

    process.exitCode = 1;

});
