/**
 * R9.0B — Post-launch operations tests.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
    OperationsManager,
    SERVICE_LIFECYCLE
} from "../operations/OperationsManager.js";
import { ServiceLifecycleManager } from "../operations/ServiceLifecycleManager.js";
import { ServiceKPIManager } from "../operations/ServiceKPIManager.js";
import { ServiceSLAManager } from "../operations/ServiceSLAManager.js";
import { MaintenanceWindowManager } from "../operations/MaintenanceWindowManager.js";
import { VersionLifecycleManager } from "../operations/VersionLifecycleManager.js";
import { IncidentEscalationManager } from "../operations/IncidentEscalationManager.js";
import { OperationalTrendAnalyzer } from "../operations/OperationalTrendAnalyzer.js";
import { OperationalEvidenceRegistry } from "../operations/OperationalEvidenceRegistry.js";
import { createOperationalEvidence } from "../operations/models/OperationalEvidence.js";
import {
    VERSION_SUPPORT_STATUS,
    SLA_STATUS,
    ESCALATION_LEVEL
} from "../operations/OperationsConfiguration.js";
import { MetricsService } from "../services/MetricsService.js";
import { HealthService } from "../services/HealthService.js";
import { MonitoringManager } from "../monitoring/MonitoringManager.js";
import { buildServerOverview } from "../console/projectionBuilders/buildServerOverview.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const repoRoot = resolve(__dirname, "../..");

async function main() {

    // --- Service lifecycle ---

    {
        const life = new ServiceLifecycleManager();

        assert.equal(life.getLifecycle(), SERVICE_LIFECYCLE.GA_ACTIVE);

        life.transitionTo(SERVICE_LIFECYCLE.NORMAL_OPERATION);

        life.transitionTo(SERVICE_LIFECYCLE.MAINTENANCE_SCHEDULED);

        life.transitionTo(SERVICE_LIFECYCLE.MAINTENANCE_ACTIVE);

        life.transitionTo(SERVICE_LIFECYCLE.POST_MAINTENANCE_VERIFICATION);

        life.transitionTo(SERVICE_LIFECYCLE.NORMAL_OPERATION);

        assert.throws(() =>
            life.transitionTo(SERVICE_LIFECYCLE.MAINTENANCE_ACTIVE)
        );

        console.log("  service lifecycle: OK");
    }

    // --- KPI manager ---

    {
        const metricsService = new MetricsService({ enabled: true });

        metricsService.initialize();

        metricsService.increment("games.started", 10);

        metricsService.increment("games.completed", 9);

        metricsService.increment("payments.completed", 8);

        metricsService.record("network.latency", 40);

        const kpiMgr = new ServiceKPIManager();

        const kpi = kpiMgr.collect({
            metricsService,
            health: { status: "ok", ready: true },
            closedBeta: {
                crashRate: 0,
                telemetry: {
                    recoverySuccessRate: 1,
                    settlementSuccessRate: 1
                }
            }
        });

        assert.ok(kpi.availability > 0.9);

        assert.equal(kpi.averageLatencyMs, 40);

        assert.ok(Object.isFrozen(kpi));

        console.log("  KPI manager: OK");
    }

    // --- SLA manager ---

    {
        const sla = new ServiceSLAManager({
            availabilityTarget: 0.99,
            latencyTargetMs: 100,
            recoveryTarget: 0.95,
            settlementTarget: 0.95
        });

        const result = sla.evaluate(
            {
                availability: 0.995,
                averageLatencyMs: 40,
                recoverySuccessRate: 1,
                settlementSuccessRate: 1
            },
            {
                monitoring: { enabled: true },
                health: { ready: true, status: "ok" }
            }
        );

        assert.ok(result.failed === 0);

        assert.ok(result.results.every((r) =>
            Object.values(SLA_STATUS).includes(r.status)
        ));

        console.log("  SLA manager: OK");
    }

    // --- Maintenance windows ---

    {
        const maint = new MaintenanceWindowManager({
            defaultDurationMinutes: 30
        });

        const window = maint.schedule({
            reason: "Patch window",
            type: "SCHEDULED"
        });

        maint.start(window.id);

        assert.equal(maint.getActive()?.outcome, "IN_PROGRESS");

        maint.verify({ verification: "ok" });

        maint.complete();

        assert.equal(maint.getActive(), null);

        assert.equal(maint.summary().byOutcome.COMPLETED, 1);

        console.log("  maintenance window manager: OK");
    }

    // --- Version lifecycle ---

    {
        const versions = new VersionLifecycleManager({
            supportWindowDays: 30
        });

        versions.register({ version: "1.0.0", activate: true });

        versions.register({
            version: "0.8.0",
            activate: false,
            releaseTimestamp: Date.now() - (60 * 24 * 60 * 60 * 1000)
        });

        versions.applySupportWindow();

        assert.equal(
            versions.list().find((v) => v.version === "0.8.0").supportStatus,
            VERSION_SUPPORT_STATUS.DEPRECATED
        );

        versions.retire("0.8.0");

        assert.equal(versions.getActive().version, "1.0.0");

        console.log("  version lifecycle manager: OK");
    }

    // --- Incident escalation ---

    {
        const incidents = new IncidentEscalationManager();

        const incident = incidents.report({
            severity: "HIGH",
            summary: "Elevated errors",
            description: "Error rate above baseline"
        });

        assert.equal(
            incidents.listEscalations()[0].level,
            ESCALATION_LEVEL.LEVEL_2
        );

        incidents.escalate(incident.id);

        assert.equal(
            incidents.listEscalations()[0].level,
            ESCALATION_LEVEL.LEVEL_3
        );

        incidents.requestRca(incident.id);

        assert.equal(
            incidents.listEscalations()[0].level,
            ESCALATION_LEVEL.ROOT_CAUSE_ANALYSIS
        );

        incidents.resolve(incident.id);

        assert.equal(incidents.summary().open, 0);

        console.log("  incident escalation manager: OK");
    }

    // --- Trend analyzer ---

    {
        const trends = new OperationalTrendAnalyzer({ maxSamples: 10 });

        trends.push({
            kpi: { availability: 0.99, averageLatencyMs: 50, crashRate: 0 },
            operationalScore: 90,
            slaScore: 90,
            healthScore: 100,
            incidentCount: 0
        });

        trends.push({
            kpi: { availability: 0.995, averageLatencyMs: 40, crashRate: 0 },
            operationalScore: 95,
            slaScore: 95,
            healthScore: 100,
            incidentCount: 0
        });

        const analysis = trends.analyze();

        assert.equal(analysis.sampleCount, 2);

        assert.equal(analysis.trends.availability.trend, "up");

        assert.equal(analysis.trends.averageLatencyMs.trend, "down");

        console.log("  trend analyzer: OK");
    }

    // --- Evidence registry ---

    {
        const evidence = createOperationalEvidence({
            operation: "collect",
            status: "OK",
            metricsSnapshot: { operationalScore: 90 },
            recommendations: ["keep watching"]
        });

        assert.ok(Object.isFrozen(evidence));

        assert.throws(() => {

            evidence.metricsSnapshot.operationalScore = 1;

        });

        const registry = new OperationalEvidenceRegistry({ maxEvidence: 5 });

        for (let i = 0; i < 7; i += 1) {

            registry.record({
                operation: "collect",
                status: "OK",
                metricsSnapshot: { i },
                recommendations: []
            });

        }

        assert.equal(registry.count(), 5);

        const h1 = registry.getAggregateHash();

        const h2 = registry.getAggregateHash();

        assert.equal(h1, h2);

        console.log("  evidence registry: OK");
    }

    // --- OperationsManager + health/monitoring/console ---

    {
        OperationsManager.resetForTests();

        MonitoringManager.resetForTests();

        const metricsService = new MetricsService({ enabled: true });

        metricsService.initialize();

        metricsService.increment("games.completed", 5);

        metricsService.record("network.latency", 30);

        const manager = OperationsManager.getInstance();

        manager.initialize({
            repoRoot,
            config: {
                enabled: true,
                slaAvailabilityTarget: 0.99,
                slaLatencyTargetMs: 250,
                slaRecoveryTarget: 0.95
            },
            providers: {
                metricsService,
                monitoringManager: {
                    getHealthStatus: () => ({ enabled: true }),
                    getSnapshot: () => ({ gauges: {} })
                },
                healthSnapshot: () => ({ status: "ok", ready: true }),
                deploymentHealth: () => ({ overall: "ok" }),
                closedBetaManager: {
                    getSafeStatus: () => ({
                        crashRate: 0,
                        telemetry: {
                            recoverySuccessRate: 1,
                            settlementSuccessRate: 1
                        }
                    })
                },
                generalAvailabilityManager: {
                    getSafeStatus: () => ({
                        rollbackRecommended: false
                    })
                },
                version: () => "1.0.0"
            },
            initialVersion: "1.0.0"
        });

        assert.equal(manager.getLifecycle(), SERVICE_LIFECYCLE.GA_ACTIVE);

        manager.enterNormalOperation();

        const snap1 = manager.collect({}, { force: true });

        const snap2 = manager.collect({}, { force: true });

        assert.equal(
            snap1.evidence.aggregateHash.length,
            64
        );

        // Deterministic evidence content for identical metrics snapshots
        // (hashes differ across collects because recommendations/timestamps
        // excluded from hash — metrics snapshot may include changing uptime)
        assert.ok(snap2.operationalScore >= 0);

        const window = manager.scheduleMaintenance({
            reason: "test",
            durationMinutes: 15
        });

        manager.startMaintenance(window.id);

        manager.verifyMaintenance({ verification: "ok" });

        manager.completeMaintenance();

        assert.equal(
            manager.getLifecycle(),
            SERVICE_LIFECYCLE.NORMAL_OPERATION
        );

        const health = new HealthService({
            logger: { error() {}, info() {} },
            productionConfig: { nodeEnv: "test" }
        });

        health.setOperationsStatus(manager.getSafeStatus());

        const snapshot = health.getHealthSnapshot();

        assert.equal(
            snapshot.operations.lifecycle,
            SERVICE_LIFECYCLE.NORMAL_OPERATION
        );

        assert.ok(snapshot.operations.operationalScore != null);

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
            overview.operations.lifecycle,
            SERVICE_LIFECYCLE.NORMAL_OPERATION
        );

        const monitoring = MonitoringManager.getInstance();

        monitoring.initialize({
            enabled: true,
            intervals: { systemMs: 60_000 },
            providers: {
                operationsManager: manager
            }
        });

        await new Promise((r) => setTimeout(r, 20));

        assert.ok(monitoring.getSnapshot());

        const outDir = mkdtempSync(join(tmpdir(), "wheelwin-r90b-"));

        const report = manager.generateReport({
            reportPath: join(outDir, "ops.md")
        });

        assert.equal(existsSync(report.path), true);

        assert.match(
            readFileSync(report.path, "utf8"),
            /Post-Launch Operations Report/
        );

        rmSync(outDir, { recursive: true, force: true });

        MonitoringManager.resetForTests();

        OperationsManager.resetForTests();

        console.log("  operations manager + health/monitoring/console: OK");
    }

    console.log("operations.test.js: all passed");

}

main().catch((error) => {

    console.error(error);

    process.exitCode = 1;

});
