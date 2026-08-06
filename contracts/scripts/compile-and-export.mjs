/**
 * R7.66B — Compile GameEscrow via Blueprint/Tact and export
 * server/payment/ton/artifacts/GameEscrow.code.boc
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
const ARTIFACT_PATH = join(ARTIFACT_DIR, "GameEscrow.code.boc");
const META_PATH = join(ARTIFACT_DIR, "GameEscrow.code.json");
const COMPILED_JSON = join(
    CONTRACTS_ROOT,
    "build",
    "GameEscrow.compiled.json"
);
const TACT_CODE_BOC = join(
    CONTRACTS_ROOT,
    "build",
    "GameEscrow",
    "GameEscrow_GameEscrow.code.boc"
);

function findCodeBoc(dir, depth = 0) {

    if (depth > 8 || !existsSync(dir)) {

        return null;

    }

    const entries = readdirSync(dir);

    const preferred = [
        "GameEscrow_GameEscrow.code.boc",
        "GameEscrow.code.boc",
        "tact_GameEscrow.code.boc"
    ];

    for (const name of preferred) {

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

        const nested = findCodeBoc(full, depth + 1);

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

function runBlueprintBuild() {

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
        [blueprintCli, "build", "GameEscrow", "--all"],
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

    // Blueprint may print a non-fatal readline close error in CI after success.
    if (
        result.status !== 0
        && !existsSync(TACT_CODE_BOC)
        && !existsSync(COMPILED_JSON)
    ) {

        throw new Error(`blueprint build failed with exit ${result.status}`);

    }

}

function resolveCodeBocPath() {

    if (existsSync(TACT_CODE_BOC)) {

        return TACT_CODE_BOC;

    }

    const found = findCodeBoc(join(CONTRACTS_ROOT, "build"));

    if (found) {

        return found;

    }

    throw new Error(
        "GameEscrow.code.boc not found under contracts/build. "
            + "Check Blueprint/Tact build output."
    );

}

function main() {

    console.log("[R7.66B] Compiling GameEscrow (Blueprint + Tact)…");

    runBlueprintBuild();

    const codeBoc = resolveCodeBocPath();

    mkdirSync(ARTIFACT_DIR, { recursive: true });

    copyFileSync(codeBoc, ARTIFACT_PATH);

    const bytes = readFileSync(ARTIFACT_PATH);
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    let codeHash = null;

    if (existsSync(COMPILED_JSON)) {

        try {

            const compiled = JSON.parse(readFileSync(COMPILED_JSON, "utf8"));

            codeHash = compiled?.hash ?? compiled?.codeHash ?? null;

        } catch {

            codeHash = null;

        }

    }

    const meta = {
        schemaVersion: 1,
        contract: "GameEscrow",
        phase: "R7.66B",
        source: "contracts/game_escrow/GameEscrow.tact",
        artifact: "server/payment/ton/artifacts/GameEscrow.code.boc",
        bytes: bytes.length,
        sha256,
        codeHash,
        compiledAt: new Date().toISOString()
    };

    writeFileSync(META_PATH, `${JSON.stringify(meta, null, 2)}\n`, "utf8");

    console.log(`[R7.66B] sourceBoc=${codeBoc}`);
    console.log(`[R7.66B] Exported ${ARTIFACT_PATH}`);
    console.log(`[R7.66B] sha256=${sha256}`);
    console.log(`[R7.66B] bytes=${bytes.length}`);
    console.log("[R7.66B] compile-contracts OK");

}

main();
