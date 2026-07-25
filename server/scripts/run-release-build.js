/**
 * R8.0B — CLI: build a Release Candidate / release package.
 *
 * Usage (from server/):
 *   node scripts/run-release-build.js
 *   node scripts/run-release-build.js --version 1.0.0-rc1 --channel rc
 *
 * Env:
 *   RELEASE_VERSION, RELEASE_CHANNEL, GIT_COMMIT, GIT_BRANCH
 */

import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { ReleaseManager } from "../release/ReleaseManager.js";
import { loadProductionConfig } from "../config/production.js";

const require = createRequire(import.meta.url);

const __dirname = dirname(fileURLToPath(import.meta.url));

const repoRoot = resolve(__dirname, "../..");

function parseArgs(argv) {

    const out = {};

    for (let i = 0; i < argv.length; i += 1) {

        const arg = argv[i];

        if (arg === "--version" || arg === "-v") {

            out.version = argv[++i];

        } else if (arg === "--channel" || arg === "-c") {

            out.channel = argv[++i];

        } else if (arg === "--output" || arg === "-o") {

            out.outputDirectory = argv[++i];

        } else if (arg === "--profile") {

            out.profile = argv[++i];

        }

    }

    return out;

}

function tryGit(command) {

    try {

        return execSync(command, {
            cwd: repoRoot,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"]
        }).trim();

    } catch {

        return null;

    }

}

const args = parseArgs(process.argv.slice(2));

const production = loadProductionConfig(process.env);

const pkg = require("../package.json");

const version = args.version
    || process.env.RELEASE_VERSION
    || pkg.version
    || "0.0.0";

const channel = args.channel
    || process.env.RELEASE_CHANNEL
    || production.release?.channel
    || "development";

const commit = process.env.GIT_COMMIT
    || process.env.COMMIT_SHA
    || tryGit("git rev-parse HEAD")
    || "unknown";

const branch = process.env.GIT_BRANCH
    || tryGit("git rev-parse --abbrev-ref HEAD")
    || "unknown";

const outputDirectory = args.outputDirectory
    || (production.release?.outputDirectory
        ? resolve(repoRoot, production.release.outputDirectory)
        : resolve(repoRoot, "release"));

process.stdout.write("R8.0B Release Build\n");

process.stdout.write(`  version=${version}\n`);

process.stdout.write(`  channel=${channel}\n`);

process.stdout.write(`  commit=${commit}\n`);

process.stdout.write(`  output=${outputDirectory}\n`);

ReleaseManager.resetForTests();

const manager = ReleaseManager.getInstance();

manager.initialize({
    channel,
    outputDirectory,
    signingEnabled: production.release?.signingEnabled === true,
    generateChecksums: production.release?.generateChecksums !== false,
    includeDocs: production.release?.includeDocs !== false,
    includeReports: production.release?.includeReports !== false,
    version,
    commit,
    branch,
    profile: args.profile || production.deployment?.profile || "development",
    repoRoot
});

const result = await manager.createRelease();

if (!result.ok) {

    process.stderr.write("Release build FAILED\n");

    for (const err of result.errors ?? []) {

        process.stderr.write(`  - ${err}\n`);

    }

    process.exit(1);

}

process.stdout.write("Release build OK\n");

process.stdout.write(`  root=${result.releaseRoot}\n`);

process.stdout.write(`  fingerprint=${result.metadata.fingerprint}\n`);

process.stdout.write(`  artifacts=${result.manifest.artifacts.length}\n`);

process.exit(0);
