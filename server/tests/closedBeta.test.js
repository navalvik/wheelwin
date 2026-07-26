/**
 * R8.0D — Closed Beta operations & telemetry tests.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
    ClosedBetaManager,
    BETA_LIFECYCLE,
    BETA_READINESS
} from "../beta/ClosedBetaManager.js";
import { BetaParticipantRegistry } from "../beta/BetaParticipantRegistry.js";
import { BetaTelemetryManager } from "../beta/BetaTelemetryManager.js";
import { BetaCrashCollector } from "../beta/BetaCrashCollector.js";
import { BetaIncidentManager } from "../beta/BetaIncidentManager.js";
import { BetaFeedbackManager } from "../beta/BetaFeedbackManager.js";
import { BetaReadinessEvaluator } from "../beta/BetaReadinessEvaluator.js";
import { BetaReportBuilder } from "../beta/BetaReportBuilder.js";
import { BetaMetricsCollector } from "../beta/BetaMetricsCollector.js";
import { redactSensitiveText } from "../beta/models/BetaCrashReport.js";
import { MetricsService } from "../services/MetricsService.js";
import { HealthService } from "../services/HealthService.js";
import { MonitoringManager } from "../monitoring/MonitoringManager.js";
import { buildServerOverview } from "../console/projectionBuilders/buildServerOverview.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const repoRoot = resolve(__dirname, "../..");

async function main() {

    // --- Participant registry ---

    {
        const registry = new BetaParticipantRegistry({ maxParticipants: 10 });

        const invited = registry.invite({
            displayLabel: "qa-alpha",
            tags: ["qa", "internal", "unknown-tag"]
        });

        assert.equal(invited.approvalStatus, "INVITED");

        assert.deepEqual([...invited.tags].sort(), ["internal", "qa"]);

        const registered = registry.register(invited.invitationCode);

        assert.equal(registered.approvalStatus, "PENDING");

        registry.approve(invited.id);

        registry.activate(invited.id);

        assert.equal(registry.get(invited.id).approvalStatus, "ACTIVE");

        const summary = registry.summary();

        assert.equal(summary.active, 1);

        assert.equal(summary.total, 1);

        const safe = registry.getSafeList();

        assert.equal(safe[0].invitationCode, undefined);

        console.log("  participant registry: OK");
    }

    // --- Telemetry collection (read-only) ---

    {
        const metricsService = new MetricsService({ enabled: true });

        metricsService.initialize();

        metricsService.increment("games.started", 5);

        metricsService.increment("games.completed", 4);

        metricsService.increment("reconnects", 2);

        metricsService.increment("payments.completed", 3);

        metricsService.increment("payments.failed", 1);

        metricsService.record("game.duration", 1000);

        metricsService.record("network.latency", 55);

        const telemetry = new BetaTelemetryManager();

        telemetry.setProviders({ metricsService });

        const snap = telemetry.collect();

        assert.equal(snap.session.gamesStarted, 5);

        assert.equal(snap.session.gamesCompleted, 4);

        assert.equal(snap.session.gamesAbandoned, 1);

        assert.equal(snap.session.reconnectCount, 2);

        assert.equal(snap.payment.paymentsCompleted, 3);

        assert.equal(snap.network.averageLatencyMs, 55);

        assert.ok(Object.isFrozen(snap));

        console.log("  telemetry collection: OK");
    }

    // --- Crash collector + redaction ---

    {
        const crashes = new BetaCrashCollector({ maxCrashReports: 5 });

        const report = crashes.recordError(
            new Error("boom secret=supersecret token:abc email@x.com"),
            { fatal: true, kind: "uncaughtException" }
        );

        assert.match(report.message, /\[REDACTED\]/);

        assert.doesNotMatch(report.message, /supersecret/);

        assert.equal(crashes.count(), 1);

        assert.ok(redactSensitiveText("UQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA").includes("[REDACTED]"));

        assert.equal(crashes.crashRate(10), 0.1);

        console.log("  crash collector: OK");
    }

    // --- Incident manager ---

    {
        const incidents = new BetaIncidentManager();

        const incident = incidents.report({
            category: "Networking",
            severity: "CRITICAL",
            description: "Socket flood observed",
            affectedVersion: "1.0.0-rc1",
            affectedParticipantIds: ["beta-p-1"]
        });

        assert.equal(incident.severity, "CRITICAL");

        assert.equal(incidents.summary().openCritical, 1);

        incidents.resolve(incident.id, {
            resolution: "Rate limited",
            rootCause: "Client reconnect storm",
            correctiveAction: "Backoff"
        });

        assert.equal(incidents.summary().openCritical, 0);

        console.log("  incident manager: OK");
    }

    // --- Feedback manager ---

    {
        const feedback = new BetaFeedbackManager();

        const item = feedback.submit({
            participantId: "beta-p-1",
            category: "UI",
            severity: "HIGH",
            summary: "Ready button lag",
            description: "Button feels delayed on mobile",
            reproductionSteps: "1. Open lobby 2. Tap Ready"
        });

        assert.equal(item.status, "OPEN");

        feedback.setStatus(item.id, "INVESTIGATING");

        assert.equal(feedback.get(item.id).status, "INVESTIGATING");

        assert.equal(feedback.openHighSeverityCount(), 1);

        console.log("  feedback manager: OK");
    }

    // --- Metrics aggregation ---

    {
        const metricsService = new MetricsService({ enabled: true });

        metricsService.initialize();

        metricsService.increment("games.completed", 2);

        const participants = new BetaParticipantRegistry();

        const telemetry = new BetaTelemetryManager();

        telemetry.setProviders({ metricsService });

        const feedback = new BetaFeedbackManager();

        const incidents = new BetaIncidentManager();

        const crashes = new BetaCrashCollector();

        const aggregator = new BetaMetricsCollector({
            telemetryManager: telemetry,
            participantRegistry: participants,
            feedbackManager: feedback,
            incidentManager: incidents,
            crashCollector: crashes
        });

        const bag = aggregator.collect();

        assert.equal(bag.telemetry.session.gamesCompleted, 2);

        assert.ok(Object.isFrozen(bag));

        console.log("  metrics aggregation: OK");
    }

    // --- Readiness evaluator ---

    {
        const evaluator = new BetaReadinessEvaluator();

        const notReady = evaluator.evaluate({
            metrics: {
                crashRate: 0.5,
                telemetry: {
                    session: { gamesCompleted: 10 },
                    network: { averageLatencyMs: 500 },
                    recovery: {
                        recoveryAttempts: 10,
                        recoverySuccessRate: 0.5,
                        recoveryFailures: 5
                    },
                    payment: {
                        paymentsCompleted: 1,
                        paymentsFailed: 9,
                        settlementSuccessRate: 0.1
                    },
                    gameplay: {
                        desynchronizationCount: 3,
                        authoritativeSyncFailures: 2
                    }
                },
                incidents: { openCritical: 2 },
                feedbackHighOpen: 10
            },
            certification: { betaReady: false, status: "FAILED" }
        });

        assert.equal(notReady.readiness, BETA_READINESS.NOT_READY);

        const ready = evaluator.evaluate({
            metrics: {
                crashRate: 0,
                telemetry: {
                    session: { gamesCompleted: 25 },
                    network: { averageLatencyMs: 40 },
                    recovery: {
                        recoveryAttempts: 4,
                        recoverySuccessRate: 1,
                        recoveryFailures: 0
                    },
                    payment: {
                        paymentsCompleted: 20,
                        paymentsFailed: 0,
                        settlementSuccessRate: 1
                    },
                    gameplay: {
                        desynchronizationCount: 0,
                        authoritativeSyncFailures: 0
                    }
                },
                incidents: { openCritical: 0 },
                feedbackHighOpen: 0
            },
            certification: { betaReady: true, status: "PASSED" }
        });

        assert.equal(ready.readiness, BETA_READINESS.READY_FOR_OPEN_BETA);

        console.log("  readiness evaluator: OK");
    }

    // --- Report generation ---

    {
        const outDir = mkdtempSync(join(tmpdir(), "wheelwin-r80d-"));

        const reportPath = join(outDir, "R8.0D-Closed-Beta-Report.md");

        const builder = new BetaReportBuilder();

        const written = builder.writeReport(reportPath, {
            lifecycle: BETA_LIFECYCLE.MONITORING,
            rcVersion: "1.0.0-rc1",
            certification: { status: "PASSED", betaReady: true },
            participants: { total: 1, active: 1, approved: 0, pending: 0, invited: 0 },
            metrics: {
                crashRate: 0,
                telemetry: {
                    activeSessions: 1,
                    session: {
                        gamesStarted: 5,
                        gamesCompleted: 5,
                        gamesAbandoned: 0,
                        reconnectCount: 0,
                        averageGameDurationMs: 1000,
                        averageSetupDurationMs: 100,
                        averagePaymentDurationMs: 200,
                        averageReadyPhaseDurationMs: 50,
                        averageSpeedPhaseDurationMs: 60,
                        averageBrakePhaseDurationMs: 70,
                        averageResultPhaseDurationMs: 80
                    },
                    network: { averageLatencyMs: 30, maximumLatencyMs: 90 },
                    recovery: {
                        recoverySuccessRate: 1,
                        recoveryFailures: 0
                    },
                    payment: {
                        paymentsInitiated: 5,
                        paymentsCompleted: 5,
                        paymentsFailed: 0,
                        settlementSuccessRate: 1,
                        settlementDurationMs: 120
                    },
                    gameplay: {
                        wheelSpins: 5,
                        desynchronizationCount: 0,
                        authoritativeSyncFailures: 0,
                        configurationValidationFailures: 0,
                        physicsAnomalies: 0
                    }
                }
            },
            readiness: {
                readiness: BETA_READINESS.READY_FOR_OPEN_BETA,
                score: 100,
                checks: [
                    Object.freeze({
                        id: "crash_rate",
                        ok: true,
                        detail: "ok",
                        weight: "hard"
                    })
                ]
            },
            feedbackSummary: {
                total: 0,
                byStatus: { OPEN: 0 },
                bySeverity: { CRITICAL: 0 }
            },
            incidentSummary: { total: 0, openCritical: 0 },
            crashSummary: { total: 0, fatal: 0, recentHour: 0 }
        });

        assert.equal(existsSync(written.path), true);

        const md = readFileSync(written.path, "utf8");

        assert.match(md, /Closed Beta Operational Report/);

        assert.match(md, /READY_FOR_OPEN_BETA/);

        rmSync(outDir, { recursive: true, force: true });

        console.log("  beta report generation: OK");
    }

    // --- ClosedBetaManager lifecycle + health/monitoring ---

    {
        ClosedBetaManager.resetForTests();

        MonitoringManager.resetForTests();

        const metricsService = new MetricsService({ enabled: true });

        metricsService.initialize();

        metricsService.increment("games.started", 12);

        metricsService.increment("games.completed", 12);

        metricsService.increment("payments.completed", 10);

        metricsService.record("network.latency", 35);

        metricsService.record("game.duration", 20000);

        const manager = ClosedBetaManager.getInstance();

        manager.initialize({
            repoRoot,
            config: {
                enabled: true,
                requireCertification: true,
                maxParticipants: 50
            },
            providers: {
                metricsService,
                certificationManager: {
                    getSafeStatus: () => ({
                        status: "PASSED",
                        betaReady: true
                    })
                },
                releaseManager: {
                    getSafeStatus: () => ({ version: "1.0.0-rc1" })
                },
                version: () => "1.0.0-rc1"
            },
            installCrashHandlers: false
        });

        assert.equal(manager.getLifecycle(), BETA_LIFECYCLE.NOT_STARTED);

        assert.throws(() => manager.transitionTo(BETA_LIFECYCLE.ACTIVE));

        manager.transitionTo(BETA_LIFECYCLE.INVITATION);

        manager.transitionTo(BETA_LIFECYCLE.ACTIVE);

        manager.transitionTo(BETA_LIFECYCLE.MONITORING);

        const p = manager.getParticipantRegistry().invite({
            displayLabel: "trusted-1",
            tags: ["trusted"]
        });

        manager.getParticipantRegistry().register(p.invitationCode);

        manager.getParticipantRegistry().approve(p.id);

        manager.getParticipantRegistry().activate(p.id);

        manager.getFeedbackManager().submit({
            participantId: p.id,
            category: "Gameplay",
            severity: "LOW",
            summary: "Fun",
            description: "All good"
        });

        const readiness = manager.evaluateReadiness();

        assert.ok(
            readiness.readiness === BETA_READINESS.READY_FOR_OPEN_BETA
            || readiness.readiness === BETA_READINESS.NEEDS_ATTENTION
        );

        const health = new HealthService({
            logger: { error() {}, info() {} },
            productionConfig: { nodeEnv: "test" }
        });

        health.setClosedBetaStatus(manager.getSafeStatus());

        const snapshot = health.getHealthSnapshot();

        assert.equal(snapshot.closedBeta.lifecycle, BETA_LIFECYCLE.MONITORING);

        assert.equal(snapshot.closedBeta.participantCount, 1);

        assert.ok(!JSON.stringify(snapshot.closedBeta).includes(p.invitationCode));

        const overview = buildServerOverview({
            version: "1.0.0-rc1",
            startedAt: Date.now(),
            healthService: health,
            roomManager: { getRooms: () => [] },
            gameManager: { getGames: () => [] },
            playerManager: { getDebugSnapshot: () => ({ players: [] }) },
            setupSessionLifecycle: { getDebugSnapshot: () => ({ activeCount: 0 }) },
            recoveryEngine: { listActiveRecoveryGameIds: () => [] },
            simulationLoop: { getActiveGameCount: () => 0 },
            socketGateway: { getConnectedSocketCount: () => 0 }
        });

        assert.equal(overview.closedBeta.lifecycle, BETA_LIFECYCLE.MONITORING);

        const monitoring = MonitoringManager.getInstance();

        monitoring.initialize({
            enabled: true,
            intervals: { systemMs: 60_000 },
            providers: {
                closedBetaManager: manager
            }
        });

        // Allow collector prime
        await new Promise((r) => setTimeout(r, 20));

        const monSnap = monitoring.getSnapshot();

        assert.ok(monSnap);

        const outDir = mkdtempSync(join(tmpdir(), "wheelwin-r80d-mgr-"));

        const report = manager.generateReport({
            reportPath: join(outDir, "report.md")
        });

        assert.equal(existsSync(report.path), true);

        rmSync(outDir, { recursive: true, force: true });

        manager.shutdown();

        MonitoringManager.resetForTests();

        ClosedBetaManager.resetForTests();

        console.log("  closed beta manager + health/monitoring: OK");
    }

    // --- Telemetry remains observational (MetricsService untouched by collect) ---

    {
        const metricsService = new MetricsService({ enabled: true });

        metricsService.initialize();

        metricsService.increment("games.started", 1);

        const before = metricsService.getSnapshot();

        const telemetry = new BetaTelemetryManager();

        telemetry.setProviders({ metricsService });

        telemetry.collect();

        const after = metricsService.getSnapshot();

        assert.deepEqual(after.counters, before.counters);

        console.log("  telemetry read-only: OK");
    }

    console.log("closedBeta.test.js: all passed");

}

main().catch((error) => {

    console.error(error);

    process.exitCode = 1;

});
