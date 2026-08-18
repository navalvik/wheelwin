/**
 * R17.9L.11 — Compile GameEscrow + DepositContract via Blueprint/Tact and export
 * server/payment/ton/artifacts/*.code.boc
 *
 * Deterministic: same Tact source + toolchain versions → same code cell BOC.
 */

import { createHash } from "node:crypto";
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    statSync,
    writeFileSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTRACTS_ROOT = resolve(__dirname, "..");
const REPO_ROOT = resolve(CONTRACTS_ROOT, "..");
const ARTIFACT_DIR = resolve(
    REPO_ROOT,
    "server",
    "payment",
    "ton",
    "artifacts"
);

const CONTRACT_TARGETS = Object.freeze([
    {
        name: "GameEscrow",
        phase: "R7.66C",
        source: "contracts/game_escrow/GameEscrow.tact",
        compiledJson: join(CONTRACTS_ROOT, "build", "GameEscrow.compiled.json"),
        preferredBocNames: [
            "GameEscrow_GameEscrow.code.boc",
            "GameEscrow.code.boc",
            "tact_GameEscrow.code.boc"
        ],
        defaultBoc: join(
            CONTRACTS_ROOT,
            "build",
            "GameEscrow",
            "GameEscrow_GameEscrow.code.boc"
        )
    },
    {
        name: "DepositContract",
        phase: "R17.9L.11",
        source: "contracts/deposit/DepositContract.tact",
        compiledJson: join(CONTRACTS_ROOT, "build", "DepositContract.compiled.json"),
        preferredBocNames: [
            "DepositContract_DepositContract.code.boc",
            "DepositContract.code.boc",
            "tact_DepositContract.code.boc"
        ],
        defaultBoc: join(
            CONTRACTS_ROOT,
            "build",
            "DepositContract",
            "DepositContract_DepositContract.code.boc"
        )
    }
]);

function findCodeBoc(dir, preferredNames, depth = 0) {

    if (depth > 8 || !existsSync(dir)) {

        return null;

    }

    const entries = readdirSync(dir);

    for (const name of preferredNames) {

        const full = join(dir, name);

        if (existsSync(full) && statSync(full).isFile()) {

            return full;

        }

    }

    for (const name of entries) {

        const full = join(dir, name);

        if (!statSync(full).isDirectory()) {

            continue;

        }

        const nested = findCodeBoc(full, preferredNames, depth + 1);

        if (nested) {

            return nested;

        }

    }

    for (const name of entries) {

        if (name.endsWith(".code.boc")) {

            return join(dir, name);

        }

    }

    return null;

}

function runBlueprintBuild(contractName) {

    const blueprintCli = join(
        CONTRACTS_ROOT,
        "node_modules",
        "@ton",
        "blueprint",
        "dist",
        "cli",
        "cli.js"
    );

    const result = spawnSync(
        process.execPath,
        [blueprintCli, "build", contractName, "--all"],
        {
            cwd: CONTRACTS_ROOT,
            stdio: "inherit",
            env: {
                ...process.env,
                CI: "true",
                FORCE_COLOR: "0"
            }
        }
    );

    return result.status;

}

function resolveCodeBocPath(target) {

    const buildSubdir = join(CONTRACTS_ROOT, "build", target.name);

    if (existsSync(buildSubdir)) {

        const found = findCodeBoc(buildSubdir, target.preferredBocNames);

        if (found) {

            return found;

        }

    }

    if (existsSync(target.defaultBoc)) {

        return target.defaultBoc;

    }

    throw new Error(
        `${target.name}.code.boc not found under contracts/build/${target.name}. `
            + "Check Blueprint/Tact build output."
    );

}

function exportContractArtifact(target) {

    console.log(`[compile-contracts] Compiling ${target.name} (Blueprint + Tact)…`);

    const exitCode = runBlueprintBuild(target.name);

    if (exitCode !== 0) {

        throw new Error(`blueprint build failed for ${target.name} with exit ${exitCode}`);

    }

    const codeBoc = resolveCodeBocPath(target);

    if (!existsSync(codeBoc)) {

        throw new Error(`${target.name}.code.boc not found after successful build`);

    }

    if (!codeBoc.includes(target.name)) {

        throw new Error(
            `Resolved BOC path does not match contract name: ${codeBoc}`
        );

    }

    const artifactPath = join(ARTIFACT_DIR, `${target.name}.code.boc`);
    const metaPath = join(ARTIFACT_DIR, `${target.name}.code.json`);

    mkdirSync(ARTIFACT_DIR, { recursive: true });

    copyFileSync(codeBoc, artifactPath);

    const bytes = readFileSync(artifactPath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    let codeHash = null;

    if (existsSync(target.compiledJson)) {

        try {

            const compiled = JSON.parse(readFileSync(target.compiledJson, "utf8"));

            codeHash = compiled?.hash ?? compiled?.codeHash ?? null;

        } catch {

            codeHash = null;

        }

    }

    const meta = {
        schemaVersion: 1,
        contract: target.name,
        phase: target.phase,
        source: target.source,
        artifact: `server/payment/ton/artifacts/${target.name}.code.boc`,
        bytes: bytes.length,
        sha256,
        codeHash,
        compiledAt: new Date().toISOString()
    };

    writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");

    console.log(`[compile-contracts] sourceBoc=${codeBoc}`);
    console.log(`[compile-contracts] Exported ${artifactPath}`);
    console.log(`[compile-contracts] sha256=${sha256}`);
    console.log(`[compile-contracts] bytes=${bytes.length}`);

    return { artifactPath, metaPath, sha256, bytes: bytes.length };

}

function main() {

    const results = [];

    for (const target of CONTRACT_TARGETS) {

        results.push({
            name: target.name,
            ...exportContractArtifact(target)
        });

    }

    console.log("[compile-contracts] OK", results);

}

main();
