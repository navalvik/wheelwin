/**
 * R9.0A — General Availability orchestration tests.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
    GeneralAvailabilityManager,
    GA_LIFECYCLE,
    VERIFICATION_STATUS
} from "../ga/GeneralAvailabilityManager.js";
import { ReleaseOrchestrator } from "../ga/ReleaseOrchestrator.js";
import { RolloutManager } from "../ga/RolloutManager.js";
import { ProductionVerificationManager } from "../ga/ProductionVerificationManager.js";
import { RollbackCoordinator } from "../ga/RollbackCoordinator.js";
import { ProductionEvidenceRegistry } from "../ga/ProductionEvidenceRegistry.js";
import { ProductionMetricsCollector } from "../ga/ProductionMetricsCollector.js";
import { createProductionEvidence } from "../ga/models/ProductionEvidence.js";
import { ROLLOUT_STAGES, ROLLOUT_MODES } from "../ga/ProductionConfiguration.js";
import { HealthService } from "../services/HealthService.js";
import { MonitoringManager } from "../monitoring/MonitoringManager.js";
import { buildServerOverview } from "../console/projectionBuilders/buildServerOverview.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const repoRoot = resolve(__dirname, "../..");

function healthyProviders() {

    return {
        releaseManager: {
            getSafeStatus: () => ({
                version: "1.0.0",
                channel: "production",
                commit: "abc123",
                fingerprint: "fp-1",
                status: "built"
            })
        },
        certificationManager: {
            getSafeStatus: () => ({
                status: "PASSED",
                betaReady: true,
                fingerprint: "cert-1"
            })
        },
        monitoringManager: {
            getHealthStatus: () => ({ enabled: true, running: true })
        },
        healthSnapshot: () => ({ status: "ok", ready: true }),
        deploymentHealth: () => ({
            profile: "production",
            ready: true,
            overall: "ok"
        }),
        tonConfig: () => ({ network: "mainnet" }),
        safeConfiguration: () => ({
            deployment: { profile: "production" }
        }),
        logging: () => ({ enabled: true }),
        failurePolicy: () => ({ enabled: true }),
        developerConsole: () => ({ enabled: true }),
        launchReadinessManager: {
            getSafeStatus: () => ({
                decision: "READY_FOR_PRODUCTION",
                productionReady: true
            })
        },
        closedBetaManager: {
            getSafeStatus: () => ({
                incidents: { openCritical: 0 }
            })
        },
        version: () => "1.0.0"
    };

}

async function main() {

    // --- Release orchestration ---

    {
        const orch = new ReleaseOrchestrator();

        orch.initialize({
            release: {
                version: "1.0.0",
                channel: "production",
                fingerprint: "fp"
            },
            certification: { status: "PASSED", fingerprint: "c" }
        });

        const result = orch.orchestrate({
            artifactOk: true,
            manifestOk: true,
            certificateOk: true,
            deploymentOk: true,
            verificationOk: true,
            verificationRef: "vh"
        });

        assert.equal(result.ok, true);

        assert.ok(result.steps.length >= 6);

        assert.equal(orch.getRelease().version, "1.0.0");

        console.log("  release orchestration: OK");
    }

    // --- Rollout manager ---

    {
        const single = new RolloutManager({ mode: ROLLOUT_MODES.SINGLE });

        single.start();

        assert.equal(single.isComplete(), true);

        assert.equal(single.getCurrentStage().stage, ROLLOUT_STAGES.COMPLETED);

        const staged = new RolloutManager({ mode: ROLLOUT_MODES.STAGED });

        staged.start();

        assert.equal(staged.getCurrentStage().stage, ROLLOUT_STAGES.INTERNAL);

        staged.advance();

        assert.equal(staged.getCurrentStage().stage, ROLLOUT_STAGES.REGIONAL);

        staged.completeAll();

        assert.equal(staged.isComplete(), true);

        console.log("  rollout manager: OK");
    }

    // --- Verification manager ---

    {
        const verifier = new ProductionVerificationManager({
            requireCertification: true
        });

        const passed = verifier.verify({
            release: {
                version: "1.0.0",
                fingerprint: "fp",
                status: "built"
            },
            certification: { status: "PASSED", betaReady: true },
            health: { status: "ok", ready: true },
            monitoring: { enabled: true },
            logging: { enabled: true },
            deployment: { profile: "production", ready: true },
            ton: { network: "mainnet" },
            failurePolicy: { enabled: true },
            developerConsole: { enabled: true },
            launch: {
                decision: "READY_FOR_PRODUCTION",
                productionReady: true
            },
            safeConfiguration: {
                deployment: { profile: "production" }
            }
        });

        assert.ok(
            passed.status === VERIFICATION_STATUS.PASSED
            || passed.status === VERIFICATION_STATUS.PASSED_WITH_WARNINGS
        );

        assert.ok(passed.score >= 90);

        assert.ok(Object.isFrozen(passed));

        const failed = verifier.verify({
            release: {},
            certification: { status: "FAILED" },
            health: { status: "not_ready", ready: false },
            launch: { decision: "BLOCKED", productionReady: false }
        });

        assert.equal(failed.status, VERIFICATION_STATUS.FAILED);

        console.log("  verification manager: OK");
    }

    // --- Rollback coordinator ---

    {
        const coordinator = new RollbackCoordinator();

        const none = coordinator.evaluate({
            verification: { status: "PASSED", checks: [] },
            closedBeta: { incidents: { openCritical: 0 } },
            allowNotReady: true
        });

        assert.equal(none.recommend, false);

        const yes = coordinator.evaluate({
            verification: {
                status: "FAILED",
                checks: [
                    {
                        id: "health",
                        status: "FAIL",
                        severity: "CRITICAL"
                    }
                ]
            },
            explicitTriggers: [
                {
                    id: "sec",
                    severity: "CRITICAL",
                    category: "security",
                    detail: "breach"
                }
            ]
        });

        assert.equal(yes.recommend, true);

        assert.ok(yes.triggers.length >= 1);

        // HIGH alone must not recommend
        const highOnly = coordinator.evaluate({
            explicitTriggers: [
                {
                    id: "h",
                    severity: "HIGH",
                    category: "ops",
                    detail: "warn"
                }
            ]
        });

        assert.equal(highOnly.recommend, false);

        console.log("  rollback coordinator: OK");
    }

    // --- Evidence registry ---

    {
        const evidence = createProductionEvidence({
            verification: "health",
            status: "PASS",
            details: { ready: true },
            recommendations: []
        });

        assert.ok(Object.isFrozen(evidence));

        assert.equal(evidence.evidenceHash.length, 64);

        assert.throws(() => {

            evidence.details.ready = false;

        });

        const registry = new ProductionEvidenceRegistry();

        registry.recordFromCheck({
            id: "a",
            name: "A",
            status: "PASS"
        });

        registry.recordFromCheck({
            id: "b",
            name: "B",
            status: "FAIL",
            recommendations: ["fix"]
        });

        const h1 = registry.getAggregateHash();

        const h2 = registry.getAggregateHash();

        assert.equal(h1, h2);

        console.log("  evidence registry: OK");
    }

    // --- Metrics collector ---

    {
        const metrics = new ProductionMetricsCollector();

        const bag = metrics.collect({
            lifecycle: GA_LIFECYCLE.GA_ACTIVE,
            releaseDurationMs: 10,
            verificationDurationMs: 5,
            rolloutDurationMs: 3,
            verificationScore: 100,
            healthScore: 100,
            deploymentScore: 100,
            operationalScore: 100,
            incidentCount: 0,
            rollbackRecommended: false,
            gaUptimeMs: 1000,
            evidenceCount: 10
        });

        assert.equal(bag.operationalScore, 100);

        assert.equal(bag.rollbackRecommended, false);

        console.log("  metrics collector: OK");
    }

    // --- Manager + health + monitoring + console ---

    {
        GeneralAvailabilityManager.resetForTests();

        MonitoringManager.resetForTests();

        const manager = GeneralAvailabilityManager.getInstance();

        manager.initialize({
            repoRoot,
            config: {
                enabled: true,
                rolloutMode: "single",
                verifyAfterRelease: true,
                postLaunchMonitoringHours: 1,
                requireCertification: true
            },
            providers: healthyProviders()
        });

        assert.equal(
            manager.getLifecycle(),
            GA_LIFECYCLE.READY_FOR_RELEASE
        );

        const run = manager.runRelease({
            overrides: {
                manifestVerified: true,
                checksumsVerified: true
            }
        });

        assert.ok(
            run.verification.status === VERIFICATION_STATUS.PASSED
            || run.verification.status
                === VERIFICATION_STATUS.PASSED_WITH_WARNINGS
        );

        assert.equal(run.rollout.complete, true);

        assert.equal(run.rollback.recommend, false);

        assert.ok(
            manager.getLifecycle() === GA_LIFECYCLE.POST_LAUNCH_MONITORING
            || manager.getLifecycle() === GA_LIFECYCLE.GA_ACTIVE
        );

        // Deterministic evidence hash on re-verify
        const v1 = manager.verifyProduction({
            manifestVerified: true,
            checksumsVerified: true
        });

        const v2 = manager.verifyProduction({
            manifestVerified: true,
            checksumsVerified: true
        });

        assert.equal(
            v1.verification.evidenceHash,
            v2.verification.evidenceHash
        );

        manager.markStable({ force: true });

        assert.equal(manager.getLifecycle(), GA_LIFECYCLE.STABLE_RELEASE);

        const health = new HealthService({
            logger: { error() {}, info() {} },
            productionConfig: { nodeEnv: "test" }
        });

        health.setGaStatus(manager.getSafeStatus());

        const snapshot = health.getHealthSnapshot();

        assert.equal(snapshot.ga.lifecycle, GA_LIFECYCLE.STABLE_RELEASE);

        assert.ok(snapshot.ga.verificationStatus);

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

        assert.equal(overview.ga.lifecycle, GA_LIFECYCLE.STABLE_RELEASE);

        const monitoring = MonitoringManager.getInstance();

        monitoring.initialize({
            enabled: true,
            intervals: { systemMs: 60_000 },
            providers: {
                generalAvailabilityManager: manager
            }
        });

        await new Promise((r) => setTimeout(r, 20));

        assert.ok(monitoring.getSnapshot());

        const outDir = mkdtempSync(join(tmpdir(), "wheelwin-r90a-"));

        const report = manager.generateReport({
            reportPath: join(outDir, "ga.md")
        });

        assert.equal(existsSync(report.path), true);

        assert.match(
            readFileSync(report.path, "utf8"),
            /General Availability Release Report/
        );

        rmSync(outDir, { recursive: true, force: true });

        MonitoringManager.resetForTests();

        GeneralAvailabilityManager.resetForTests();

        console.log("  health / monitoring / console integration: OK");
    }

    console.log("generalAvailability.test.js: all passed");

}

main().catch((error) => {

    console.error(error);

    process.exitCode = 1;

});
