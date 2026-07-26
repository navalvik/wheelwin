/**
 * R8.0E — Launch readiness & production gate tests.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
    LaunchReadinessManager,
    LAUNCH_LIFECYCLE,
    LAUNCH_DECISION
} from "../launch/LaunchReadinessManager.js";
import { LaunchGateEvaluator } from "../launch/LaunchGateEvaluator.js";
import { LaunchDecisionManager } from "../launch/LaunchDecisionManager.js";
import { OpenBetaReadinessEvaluator } from "../launch/OpenBetaReadinessEvaluator.js";
import { ProductionLaunchEvaluator } from "../launch/ProductionLaunchEvaluator.js";
import { LaunchEvidenceRegistry } from "../launch/LaunchEvidenceRegistry.js";
import { LaunchChecklist } from "../launch/LaunchChecklist.js";
import { LaunchMetricsCollector } from "../launch/LaunchMetricsCollector.js";
import { createLaunchEvidence } from "../launch/models/LaunchEvidence.js";
import { evaluateGate } from "../launch/LaunchGateEvaluator.js";
import { BETA_READINESS, BETA_LIFECYCLE } from "../beta/BetaConfiguration.js";
import { HealthService } from "../services/HealthService.js";
import { MonitoringManager } from "../monitoring/MonitoringManager.js";
import { buildServerOverview } from "../console/projectionBuilders/buildServerOverview.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const repoRoot = resolve(__dirname, "../..");

function healthyClosedBeta() {

    return {
        lifecycle: BETA_LIFECYCLE.OPEN_BETA_READY,
        readiness: BETA_READINESS.READY_FOR_OPEN_BETA,
        readinessScore: 100,
        crashRate: 0,
        participantCount: 5,
        certificationStatus: "PASSED",
        certificationBetaReady: true,
        incidents: { openCritical: 0 },
        telemetry: {
            averageLatencyMs: 40,
            recoverySuccessRate: 1,
            settlementSuccessRate: 1
        }
    };

}

async function main() {

    // --- Gate evaluation ---

    {
        const gate = evaluateGate({
            id: "t1",
            name: "Test gate",
            ok: true,
            severity: "HIGH"
        });

        assert.equal(gate.status, "PASS");

        assert.ok(Object.isFrozen(gate));

        const fail = evaluateGate({
            id: "t2",
            name: "Fail gate",
            ok: false,
            severity: "CRITICAL"
        });

        assert.equal(fail.status, "FAIL");

        const summary = new LaunchGateEvaluator().summarize([gate, fail]);

        assert.equal(summary.passed, 1);

        assert.equal(summary.failed, 1);

        assert.equal(summary.criticalBlockers, 1);

        console.log("  launch gate evaluation: OK");
    }

    // --- Evidence immutability + hash ---

    {
        const evidence = createLaunchEvidence({
            gate: "crash_rate",
            status: "PASS",
            timestamp: 1,
            durationMs: 2,
            details: { crashRate: 0 },
            recommendations: []
        });

        assert.ok(Object.isFrozen(evidence));

        assert.ok(evidence.evidenceHash.length === 64);

        assert.throws(() => {

            evidence.details.crashRate = 1;

        });

        const registry = new LaunchEvidenceRegistry();

        registry.recordFromGate(evaluateGate({
            id: "a",
            name: "A",
            ok: true
        }));

        registry.recordFromGate(evaluateGate({
            id: "b",
            name: "B",
            ok: false,
            severity: "HIGH"
        }));

        const hash1 = registry.getAggregateHash();

        const hash2 = registry.getAggregateHash();

        assert.equal(hash1, hash2);

        console.log("  evidence generation: OK");
    }

    // --- Checklist validation ---

    {
        const checklist = new LaunchChecklist({ repoRoot });

        const result = checklist.validate({ skipOptional: true });

        assert.ok(result.required > 0);

        assert.ok(result.completeness > 0);

        assert.ok(result.results.every((r) => Object.isFrozen(r)));

        console.log("  checklist validation: OK");
    }

    // --- Open Beta readiness evaluator ---

    {
        const evaluator = new OpenBetaReadinessEvaluator({ repoRoot });

        const ready = evaluator.evaluate({
            closedBeta: healthyClosedBeta(),
            certification: { status: "PASSED", betaReady: true },
            monitoring: { enabled: true, running: true },
            health: { status: "ok", ready: true },
            developerConsole: { enabled: true }
        });

        assert.equal(ready.ready, true);

        assert.ok(ready.score >= 90);

        const blocked = evaluator.evaluate({
            closedBeta: {
                ...healthyClosedBeta(),
                readiness: "NOT_READY",
                lifecycle: "NOT_STARTED",
                crashRate: 0.5,
                incidents: { openCritical: 2 }
            },
            certification: { status: "FAILED", betaReady: false }
        });

        assert.equal(blocked.ready, false);

        assert.ok(blocked.blockers.some((b) => b.severity === "CRITICAL"));

        console.log("  open beta readiness: OK");
    }

    // --- Launch decision computation ---

    {
        const manager = new LaunchDecisionManager();

        const openReady = {
            ready: true,
            score: 100,
            blockers: []
        };

        const prodNotReady = {
            ready: false,
            score: 60,
            blockers: [
                {
                    id: "mainnet_configuration",
                    severity: "CRITICAL",
                    name: "Mainnet",
                    category: "blockchain",
                    recommendations: []
                }
            ]
        };

        const d1 = manager.decide({
            openBeta: openReady,
            production: prodNotReady,
            evidenceHash: "abc"
        });

        assert.equal(d1.decision, LAUNCH_DECISION.READY_FOR_OPEN_BETA);

        assert.equal(d1.openBetaReady, true);

        assert.equal(d1.productionReady, false);

        const d2 = manager.decide({
            openBeta: openReady,
            production: {
                ready: true,
                score: 95,
                blockers: []
            }
        });

        assert.equal(d2.decision, LAUNCH_DECISION.READY_FOR_PRODUCTION);

        const d3 = manager.decide({
            openBeta: {
                ready: false,
                score: 40,
                blockers: [
                    {
                        id: "crash_rate",
                        severity: "CRITICAL",
                        name: "Crash",
                        category: "stability",
                        recommendations: []
                    }
                ]
            },
            production: { ready: false, score: 0, blockers: [] }
        });

        assert.equal(d3.decision, LAUNCH_DECISION.BLOCKED);

        console.log("  launch decision computation: OK");
    }

    // --- Readiness scoring + metrics ---

    {
        const metrics = new LaunchMetricsCollector();

        const bag = metrics.collect({
            openBeta: {
                gates: [
                    { status: "PASS" },
                    { status: "PASS" },
                    { status: "FAIL" }
                ],
                score: 66
            },
            production: {
                gates: [{ status: "PASS" }],
                score: 100,
                documentationCompleteness: 0.9
            },
            decision: {
                decision: LAUNCH_DECISION.READY_FOR_OPEN_BETA,
                score: 80,
                blockers: [{ severity: "HIGH" }],
                openBetaReady: true,
                gaReady: false,
                productionReady: false
            },
            evidenceSummary: { total: 4 },
            durationMs: 12,
            lifecycle: LAUNCH_LIFECYCLE.CLOSED_BETA_REVIEW,
            health: { ready: true, status: "ok" }
        });

        assert.equal(bag.gateFailureCount, 1);

        assert.ok(bag.gatePassRate > 0.5);

        assert.equal(bag.operationalReadinessScore, 80);

        console.log("  metrics collection / readiness scoring: OK");
    }

    // --- Production evaluator (isolated tmp docs) ---

    {
        const tmp = mkdtempSync(join(tmpdir(), "wheelwin-r80e-"));

        mkdirSync(join(tmp, "docs/release"), { recursive: true });

        writeFileSync(
            join(tmp, "docs/release/R8.0D-Closed-Beta-Report.md"),
            "# closed\n"
        );

        writeFileSync(
            join(tmp, "docs/release/R8.0E-Open-Beta-Readiness-Report.md"),
            "# open\n"
        );

        // Minimal alt docs via architecture paths used as fallbacks
        mkdirSync(join(tmp, "docs/architecture"), { recursive: true });

        writeFileSync(
            join(
                tmp,
                "docs/architecture/R7.0G-Production-Health-Readiness-Deployment-Validation.md"
            ),
            "# runbook\n"
        );

        writeFileSync(
            join(
                tmp,
                "docs/architecture/R7.0F-Failure-Recovery-Policies-Validation.md"
            ),
            "# rollback\n"
        );

        const evaluator = new ProductionLaunchEvaluator({
            repoRoot: tmp,
            requireMainnetForGa: true
        });

        const assessment = evaluator.evaluate({
            lifecycle: LAUNCH_LIFECYCLE.OPEN_BETA_RUNNING,
            openBeta: { ready: true, blockers: [] },
            closedBeta: healthyClosedBeta(),
            certification: { status: "PASSED", betaReady: true },
            release: {
                version: "1.0.0-rc1",
                fingerprint: "fp",
                status: "built"
            },
            deployment: { profile: "production", ready: true },
            ton: { network: "mainnet" },
            safeConfiguration: {
                deployment: { profile: "production" },
                ton: { network: "mainnet" }
            },
            monitoring: { enabled: true },
            health: { status: "ok", ready: true },
            logging: { enabled: true },
            failurePolicy: { enabled: true },
            openBetaReportPresent: true,
            releaseArtifactsVerified: true
        });

        assert.ok(assessment.gates.length > 5);

        assert.ok(Object.isFrozen(assessment));

        rmSync(tmp, { recursive: true, force: true });

        console.log("  production launch evaluator: OK");
    }

    // --- Manager + health + monitoring + console ---

    {
        LaunchReadinessManager.resetForTests();

        MonitoringManager.resetForTests();

        const manager = LaunchReadinessManager.getInstance();

        manager.initialize({
            repoRoot,
            config: {
                enabled: true,
                requireMainnetForGa: false
            },
            providers: {
                closedBetaManager: {
                    getSafeStatus: () => healthyClosedBeta()
                },
                certificationManager: {
                    getSafeStatus: () => ({
                        status: "PASSED",
                        betaReady: true
                    })
                },
                releaseManager: {
                    getSafeStatus: () => ({
                        version: "1.0.0-rc1",
                        fingerprint: "fp",
                        status: "built"
                    })
                },
                monitoringManager: {
                    getHealthStatus: () => ({ enabled: true, running: true })
                },
                healthSnapshot: () => ({ status: "ok", ready: true }),
                deploymentHealth: () => ({
                    profile: "staging",
                    ready: true
                }),
                tonConfig: () => ({ network: "testnet" }),
                safeConfiguration: () => ({
                    deployment: { profile: "staging" }
                }),
                logging: () => ({ enabled: true }),
                failurePolicy: () => ({ enabled: true }),
                developerConsole: () => ({ enabled: true }),
                version: () => "1.0.0-rc1"
            }
        });

        assert.equal(manager.getLifecycle(), LAUNCH_LIFECYCLE.NOT_EVALUATED);

        const evaluation = manager.evaluate({
            skipMainnetCheck: true,
            releaseArtifactsVerified: true,
            rollbackVerified: true,
            openBetaReportPresent: true
        });

        assert.ok(evaluation.decision.evidenceHash);

        assert.ok(
            evaluation.decision.decision === LAUNCH_DECISION.READY_FOR_OPEN_BETA
            || evaluation.decision.decision === LAUNCH_DECISION.READY_FOR_GA
            || evaluation.decision.decision
                === LAUNCH_DECISION.READY_FOR_PRODUCTION
            || evaluation.decision.decision === LAUNCH_DECISION.NOT_READY
        );

        // Determinism: same inputs → same evidence aggregate
        const e2 = manager.evaluate({
            skipMainnetCheck: true,
            releaseArtifactsVerified: true,
            rollbackVerified: true,
            openBetaReportPresent: true
        });

        assert.equal(
            evaluation.evidenceSummary.aggregateHash,
            e2.evidenceSummary.aggregateHash
        );

        const health = new HealthService({
            logger: { error() {}, info() {} },
            productionConfig: { nodeEnv: "test" }
        });

        health.setLaunchStatus(manager.getSafeStatus());

        const snapshot = health.getHealthSnapshot();

        assert.ok(snapshot.launch.decision);

        assert.ok(snapshot.launch.gateSummary);

        const overview = buildServerOverview({
            version: "1.0.0-rc1",
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
            overview.launch.decision,
            snapshot.launch.decision
        );

        const monitoring = MonitoringManager.getInstance();

        monitoring.initialize({
            enabled: true,
            intervals: { systemMs: 60_000 },
            providers: {
                launchReadinessManager: manager
            }
        });

        await new Promise((r) => setTimeout(r, 20));

        assert.ok(monitoring.getSnapshot());

        const outDir = mkdtempSync(join(tmpdir(), "wheelwin-r80e-rep-"));

        const reports = manager.generateReports({
            write: true,
            openBetaReportPath: join(outDir, "open.md"),
            productionReportPath: join(outDir, "prod.md"),
            overrides: {
                skipMainnetCheck: true,
                releaseArtifactsVerified: true,
                rollbackVerified: true
            }
        });

        assert.equal(existsSync(reports.openBeta.path), true);

        assert.equal(existsSync(reports.production.path), true);

        assert.match(
            readFileSync(reports.openBeta.path, "utf8"),
            /Open Beta Readiness Report/
        );

        assert.match(
            readFileSync(reports.production.path, "utf8"),
            /Production Launch Readiness Report/
        );

        rmSync(outDir, { recursive: true, force: true });

        MonitoringManager.resetForTests();

        LaunchReadinessManager.resetForTests();

        console.log("  health / monitoring / console integration: OK");
    }

    console.log("launchReadiness.test.js: all passed");

}

main().catch((error) => {

    console.error(error);

    process.exitCode = 1;

});
