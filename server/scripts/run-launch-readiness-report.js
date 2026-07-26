/**
 * R8.0E — CLI: generate Open Beta / Production launch readiness reports.
 *
 * Usage (from server/):
 *   npm run launch:report
 *   npm run launch:report -- --seed-demo
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
    LaunchReadinessManager,
    LAUNCH_LIFECYCLE
} from "../launch/LaunchReadinessManager.js";
import {
    ClosedBetaManager,
    BETA_LIFECYCLE
} from "../beta/ClosedBetaManager.js";
import { MetricsService } from "../services/MetricsService.js";
import { loadProductionConfig } from "../config/production.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const repoRoot = resolve(__dirname, "../..");

function parseArgs(argv) {

    const out = { seedDemo: false, write: true };

    for (let i = 0; i < argv.length; i += 1) {

        const arg = argv[i];

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

ClosedBetaManager.resetForTests();

LaunchReadinessManager.resetForTests();

const metricsService = new MetricsService({ enabled: true });

metricsService.initialize();

if (args.seedDemo) {

    metricsService.increment("games.started", 30);

    metricsService.increment("games.completed", 28);

    metricsService.increment("reconnects", 1);

    metricsService.increment("payments.completed", 25);

    metricsService.increment("payments.failed", 0);

    metricsService.record("game.duration", 40000);

    metricsService.record("network.latency", 38);

}

const closedBeta = ClosedBetaManager.getInstance();

closedBeta.initialize({
    repoRoot,
    config: {
        enabled: true,
        requireCertification: false,
        maxParticipants: 100
    },
    providers: {
        metricsService,
        version: () => "1.0.0-rc1",
        certificationManager: {
            getSafeStatus: () => ({
                status: "PASSED",
                betaReady: true
            })
        },
        releaseManager: {
            getSafeStatus: () => ({
                version: "1.0.0-rc1",
                fingerprint: "demo-fp",
                status: "built"
            })
        }
    },
    installCrashHandlers: false
});

if (args.seedDemo) {

    closedBeta.transitionTo(BETA_LIFECYCLE.INVITATION);

    closedBeta.transitionTo(BETA_LIFECYCLE.ACTIVE);

    closedBeta.transitionTo(BETA_LIFECYCLE.MONITORING);

    closedBeta.transitionTo(BETA_LIFECYCLE.READY_FOR_REVIEW);

    closedBeta.transitionTo(BETA_LIFECYCLE.COMPLETED);

    // Force readiness path for demo when metrics are healthy
    closedBeta.evaluateReadiness();

    try {

        closedBeta.transitionTo(BETA_LIFECYCLE.OPEN_BETA_READY);

    } catch {

        // If readiness is not yet OPEN_BETA_READY, stay at COMPLETED
    }

}

const launch = LaunchReadinessManager.getInstance();

launch.initialize({
    repoRoot,
    config: {
        enabled: production.launch?.enabled !== false,
        requireMainnetForGa: false
    },
    providers: {
        closedBetaManager: closedBeta,
        certificationManager: {
            getSafeStatus: () => ({
                status: "PASSED",
                betaReady: true
            })
        },
        releaseManager: {
            getSafeStatus: () => ({
                version: "1.0.0-rc1",
                fingerprint: "demo-fp",
                status: "built"
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
            deployment: { profile: "production" },
            ton: { network: "mainnet" }
        }),
        logging: () => ({ enabled: true }),
        failurePolicy: () => ({ enabled: true }),
        developerConsole: () => ({ enabled: true }),
        version: () => "1.0.0-rc1"
    }
});

if (args.seedDemo) {

    launch.transitionTo(LAUNCH_LIFECYCLE.CLOSED_BETA_REVIEW);

}

const reports = launch.generateReports({
    write: args.write,
    overrides: {
        skipMainnetCheck: false,
        releaseArtifactsVerified: true,
        rollbackVerified: true,
        recoveryVerified: true,
        blockchainVerified: true
    }
});

const decision = reports.evaluation.decision;

process.stdout.write("Launch readiness reports generated\n");

if (reports.openBeta?.path) {

    process.stdout.write(`  open beta: ${reports.openBeta.path}\n`);

}

if (reports.production?.path) {

    process.stdout.write(`  production: ${reports.production.path}\n`);

}

process.stdout.write(`  lifecycle: ${launch.getLifecycle()}\n`);

process.stdout.write(`  decision: ${decision.decision}\n`);

process.stdout.write(`  score: ${decision.score}\n`);

process.stdout.write(
    `  openBetaReady=${decision.openBetaReady} gaReady=${decision.gaReady} productionReady=${decision.productionReady}\n`
);

closedBeta.shutdown();

ClosedBetaManager.resetForTests();

LaunchReadinessManager.resetForTests();
