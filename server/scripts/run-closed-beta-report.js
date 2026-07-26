/**
 * R8.0D — CLI: generate Closed Beta operational report.
 *
 * Usage (from server/):
 *   npm run beta:report
 *   npm run beta:report -- --seed-demo
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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

        } else if (arg === "--out") {

            out.reportPath = argv[++i];

        }

    }

    return out;

}

const args = parseArgs(process.argv.slice(2));

const production = loadProductionConfig(process.env);

ClosedBetaManager.resetForTests();

const metricsService = new MetricsService({ enabled: true });

metricsService.initialize();

const manager = ClosedBetaManager.getInstance();

manager.initialize({
    repoRoot,
    config: {
        enabled: production.closedBeta?.enabled !== false,
        requireCertification: false,
        maxParticipants: production.closedBeta?.maxParticipants ?? 500
    },
    providers: {
        metricsService,
        version: () => process.env.npm_package_version ?? "1.0.0",
        environment: () => process.env.NODE_ENV ?? "development",
        profile: () => "development",
        certificationManager: {
            getSafeStatus: () => ({
                status: "PASSED",
                betaReady: true
            })
        },
        releaseManager: {
            getSafeStatus: () => ({
                version: process.env.RELEASE_VERSION ?? "1.0.0-rc1"
            })
        }
    },
    installCrashHandlers: false
});

if (args.seedDemo) {

    metricsService.increment("games.started", 20);

    metricsService.increment("games.completed", 18);

    metricsService.increment("reconnects", 2);

    metricsService.increment("payments.completed", 17);

    metricsService.increment("payments.failed", 0);

    metricsService.record("game.duration", 45000);

    metricsService.record("network.latency", 42);

    const invited = manager.getParticipantRegistry().invite({
        displayLabel: "qa-1",
        tags: ["qa", "internal"]
    });

    manager.getParticipantRegistry().register(invited.invitationCode);

    manager.getParticipantRegistry().approve(invited.id);

    manager.getParticipantRegistry().activate(invited.id);

    manager.getFeedbackManager().submit({
        participantId: invited.id,
        category: "Performance",
        severity: "LOW",
        summary: "Smooth overall",
        description: "No blocking issues in demo seed."
    });

    manager.transitionTo(BETA_LIFECYCLE.INVITATION);

    manager.transitionTo(BETA_LIFECYCLE.ACTIVE);

    manager.transitionTo(BETA_LIFECYCLE.MONITORING);

}

const result = manager.generateReport({
    write: args.write,
    reportPath: args.reportPath
        ? resolve(process.cwd(), args.reportPath)
        : undefined
});

process.stdout.write(
    `Closed Beta report ${args.write ? "written" : "generated"}\n`
);

if (result.path) {

    process.stdout.write(`  path: ${result.path}\n`);

}

process.stdout.write(`  lifecycle: ${manager.getLifecycle()}\n`);

process.stdout.write(`  readiness: ${result.readiness.readiness}\n`);

process.stdout.write(`  score: ${result.readiness.score}\n`);

manager.shutdown();

ClosedBetaManager.resetForTests();
