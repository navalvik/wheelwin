/**
 * R8.0C — CLI: certify a Release Candidate package.
 *
 * Usage (from server/):
 *   node scripts/run-release-certification.js --release ../release/wheelwin-1.0.0-rc1-rc
 *   npm run release:certify -- --release <path>
 */

import { existsSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ReleaseCertificationManager } from "../certification/ReleaseCertificationManager.js";
import { loadProductionConfig } from "../config/production.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const repoRoot = resolve(__dirname, "../..");

function parseArgs(argv) {

    const out = {};

    for (let i = 0; i < argv.length; i += 1) {

        const arg = argv[i];

        if (arg === "--release" || arg === "-r") {

            out.releaseRoot = argv[++i];

        } else if (arg === "--version") {

            out.version = argv[++i];

        }

    }

    return out;

}

function findLatestRelease(outputDir) {

    const abs = resolve(repoRoot, outputDir);

    if (!existsSync(abs)) {

        return null;

    }

    const dirs = readdirSync(abs, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();

    if (!dirs.length) {

        return null;

    }

    return join(abs, dirs[dirs.length - 1]);

}

const args = parseArgs(process.argv.slice(2));

const production = loadProductionConfig(process.env);

let releaseRoot = args.releaseRoot
    ? resolve(process.cwd(), args.releaseRoot)
    : null;

if (!releaseRoot) {

    releaseRoot = findLatestRelease(
        production.release?.outputDirectory || "release"
    );

}

if (!releaseRoot || !existsSync(releaseRoot)) {

    process.stderr.write(
        "Release package not found. Build first with npm run release:build\n"
    );

    process.exit(1);

}

process.stdout.write("R8.0C Release Certification\n");

process.stdout.write(`  releaseRoot=${releaseRoot}\n`);

ReleaseCertificationManager.resetForTests();

const manager = ReleaseCertificationManager.getInstance();

manager.initialize({
    repoRoot,
    productionConfig: production,
    profile: production.deployment?.profile || "development",
    tonConfig: {
        network: process.env.TON_NETWORK || "testnet",
        deployMode: process.env.TON_DEPLOY_MODE || "stub",
        endpointConfigured: Boolean(process.env.TON_ENDPOINT),
        apiKeyConfigured: Boolean(process.env.TON_API_KEY),
        mnemonicConfigured: Boolean(process.env.TON_DEPLOYER_MNEMONIC)
    },
    safeConfiguration: {
        profile: production.deployment?.profile || "development",
        developerConsole: {
            authEnabled: true,
            authConfigured: true
        }
    }
});

const result = await manager.certify({
    releaseRoot,
    expectedVersion: args.version,
    writeOutputs: true
});

process.stdout.write(`  status=${result.status}\n`);

process.stdout.write(
    `  betaReady=${result.certificate?.betaReady === true}\n`
);

if (result.reportPath) {

    process.stdout.write(`  report=${result.reportPath}\n`);

}

if (!result.ok) {

    process.stderr.write("Certification FAILED\n");

    for (const item of result.evidence ?? []) {

        if (item.status === "FAIL") {

            process.stderr.write(`  [FAIL] ${item.name}\n`);

            for (const rec of item.recommendations ?? []) {

                process.stderr.write(`         - ${rec}\n`);

            }

        }

    }

    process.exit(1);

}

process.stdout.write("Certification OK — Closed Beta may proceed\n");

process.exit(0);
