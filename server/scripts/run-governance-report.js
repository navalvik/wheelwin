/**
 * R9.0C — CLI: generate platform governance report.
 *
 * Usage (from server/):
 *   npm run governance:report
 *   npm run governance:report -- --seed-demo
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
    GovernanceManager,
    GOVERNANCE_LIFECYCLE
} from "../governance/GovernanceManager.js";
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

GovernanceManager.resetForTests();

const gov = GovernanceManager.getInstance();

gov.initialize({
    repoRoot,
    config: {
        enabled: production.governance?.enabled !== false,
        auditIntervalDays: production.governance?.auditIntervalDays ?? 30,
        complianceRequired:
            production.governance?.complianceRequired !== false,
        riskReviewIntervalDays:
            production.governance?.riskReviewIntervalDays ?? 30,
        evidenceRetentionDays:
            production.governance?.evidenceRetentionDays ?? 365,
        platformReviewIntervalDays:
            production.governance?.platformReviewIntervalDays ?? 90
    },
    providers: {
        monitoringManager: {
            getHealthStatus: () => ({ enabled: true, running: true })
        },
        healthSnapshot: () => ({ status: "ok", ready: true }),
        deploymentHealth: () => ({
            overall: "ok",
            ready: true,
            profile: "development"
        }),
        operationsManager: {
            getSafeStatus: () => ({
                enabled: true,
                lifecycle: "NORMAL_OPERATION",
                operationalScore: 97
            })
        },
        releaseManager: {
            getSafeStatus: () => ({ version: "1.0.0" })
        },
        certificationManager: {
            getSafeStatus: () => ({
                status: "PASSED",
                betaReady: true
            })
        },
        generalAvailabilityManager: {
            getSafeStatus: () => ({
                lifecycle: "STABLE_RELEASE",
                rollbackRecommended: false
            })
        },
        closedBetaManager: {
            getSafeStatus: () => ({
                crashRate: 0,
                telemetry: {
                    recoverySuccessRate: 1,
                    settlementSuccessRate: 1
                }
            })
        },
        failurePolicy: () => ({ enabled: true }),
        safeConfiguration: () => ({
            profile: "development",
            deployment: { profile: "development" }
        }),
        developerConsole: () => ({ enabled: true }),
        tonConfig: () => ({ network: "testnet", deployMode: "stub" }),
        version: () => "1.0.0"
    }
});

if (args.seedDemo) {

    const change = gov.getChangeManager().propose({
        title: "Demo governance policy review",
        category: "Governance",
        description: "Periodic policy interval confirmation"
    });

    gov.getChangeManager().setStatus(change.id, "RECORDED");

}

const snapshot = gov.runCycle({
    autoAdvanceLifecycle: true,
    overrides: args.seedDemo
        ? { documentationPresent: true, evidencePresent: true }
        : { documentationPresent: true }
});

const report = gov.generateReport({ write: args.write });

process.stdout.write("Platform governance report generated\n");

if (report.path) {

    process.stdout.write(`  path: ${report.path}\n`);

}

process.stdout.write(`  lifecycle: ${gov.getLifecycle()}\n`);

process.stdout.write(`  cycle: ${snapshot.cycle}\n`);

process.stdout.write(`  score: ${report.governanceScore}\n`);

process.stdout.write(`  decision: ${report.decision?.status ?? "n/a"}\n`);

process.stdout.write(
    `  expected terminal: ${GOVERNANCE_LIFECYCLE.NEXT_AUDIT_CYCLE}\n`
);

GovernanceManager.resetForTests();
