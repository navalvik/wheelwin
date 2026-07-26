/**
 * R9.0B — CLI: generate post-launch operations report.
 *
 * Usage (from server/):
 *   npm run operations:report
 *   npm run operations:report -- --seed-demo
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
    OperationsManager,
    SERVICE_LIFECYCLE
} from "../operations/OperationsManager.js";
import { MetricsService } from "../services/MetricsService.js";
import { loadProductionConfig } from "../config/production.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const repoRoot = resolve(__dirname, "../..");

function parseArgs(argv) {

    const out = { seedDemo: false, write: true };

    for (const arg of argv) {

        if (arg === "--seed-demo") {

            out.seedDemo = true;

        } else if (arg === "--no-write") {

            out.write = false;

        }

    }

    return out;

}

const args = parseArgs(process.argv.slice(2));

const production = loadProductionConfig(process.env);

OperationsManager.resetForTests();

const metricsService = new MetricsService({ enabled: true });

metricsService.initialize();

if (args.seedDemo) {

    metricsService.increment("games.started", 40);

    metricsService.increment("games.completed", 38);

    metricsService.increment("reconnects", 2);

    metricsService.increment("payments.completed", 35);

    metricsService.increment("payments.failed", 0);

    metricsService.record("game.duration", 42000);

    metricsService.record("network.latency", 45);

    metricsService.record("network.latency", 60);

}

const ops = OperationsManager.getInstance();

ops.initialize({
    repoRoot,
    config: {
        enabled: production.operations?.enabled !== false,
        slaAvailabilityTarget:
            production.operations?.slaAvailabilityTarget ?? 0.995,
        slaLatencyTargetMs:
            production.operations?.slaLatencyTargetMs ?? 250,
        slaRecoveryTarget: production.operations?.slaRecoveryTarget ?? 0.95,
        maintenanceDefaultDurationMinutes:
            production.operations?.maintenanceDefaultDurationMinutes ?? 60,
        versionSupportWindowDays:
            production.operations?.versionSupportWindowDays ?? 90
    },
    providers: {
        metricsService,
        monitoringManager: {
            getHealthStatus: () => ({ enabled: true, running: true }),
            getSnapshot: () => ({ gauges: {} })
        },
        healthSnapshot: () => ({ status: "ok", ready: true }),
        deploymentHealth: () => ({ overall: "ok", ready: true }),
        closedBetaManager: {
            getSafeStatus: () => ({
                crashRate: 0,
                crashCount: 0,
                activeSessions: 3,
                telemetry: {
                    averageLatencyMs: 45,
                    recoverySuccessRate: 1,
                    settlementSuccessRate: 1
                },
                incidents: { openCritical: 0 }
            })
        },
        generalAvailabilityManager: {
            getSafeStatus: () => ({
                lifecycle: "STABLE_RELEASE",
                rollbackRecommended: false
            })
        },
        releaseManager: {
            getSafeStatus: () => ({ version: "1.0.0" })
        },
        version: () => "1.0.0"
    },
    initialVersion: "1.0.0"
});

ops.enterNormalOperation("seed");

if (args.seedDemo) {

    ops.getVersionManager().register({
        version: "0.9.0",
        activate: false,
        releaseTimestamp: Date.now() - (120 * 24 * 60 * 60 * 1000)
    });

    ops.getVersionManager().applySupportWindow();

    const window = ops.scheduleMaintenance({
        reason: "Demo scheduled maintenance",
        durationMinutes: 30
    });

    ops.startMaintenance(window.id);

    ops.verifyMaintenance({
        verification: "Health and monitoring verified"
    });

    ops.completeMaintenance();

    ops.getIncidentManager().report({
        severity: "LOW",
        category: "Performance",
        summary: "Minor latency spike observed",
        description: "Transient spike during demo seed"
    });

    ops.collect({}, { force: true });

    ops.collect({}, { force: true });

}

const report = ops.generateReport({ write: args.write });

process.stdout.write("Post-launch operations report generated\n");

if (report.path) {

    process.stdout.write(`  path: ${report.path}\n`);

}

process.stdout.write(`  lifecycle: ${ops.getLifecycle()}\n`);

process.stdout.write(`  score: ${report.operationalScore}\n`);

process.stdout.write(`  assessment: ${report.assessment}\n`);

process.stdout.write(
    `  version: ${report.versions?.activeVersion ?? "n/a"}\n`
);

OperationsManager.resetForTests();
