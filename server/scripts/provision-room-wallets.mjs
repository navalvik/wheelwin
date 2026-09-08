#!/usr/bin/env node
/**
 * Offline Room Wallet provisioning (testnet or mainnet).
 *
 * Legacy (TESTNET):
 *   node scripts/provision-room-wallets.mjs --output-dir <absolute-path-outside-git>
 *
 * Explicit network:
 *   node scripts/provision-room-wallets.mjs --network <testnet|mainnet> --output-dir <absolute-path-outside-git>
 *
 * Mainnet requires --network mainnet. Network is never inferred from the
 * output directory name.
 *
 * Writes two files into the output directory and prints only public metadata
 * and SHA-256 hashes. Never prints secretKey, mnemonic, seed, or raw JSON.
 *
 * Does not send blockchain transactions, fund wallets, or change Railway.
 */

import { execFileSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ConfigurationIssueCollector } from "../config/ConfigurationError.js";
import { validateSecrets } from "../config/validators/validateSecrets.js";
import { loadRoomWalletRuntimeConfig } from "../payment/roomWallet/RoomWalletRuntimeResolver.js";
import {
    assertOutputDirSafe,
    buildMasterBackup,
    buildPublicSummary,
    buildRuntimePayload,
    formatPublicSummaryLines,
    generateRoomWalletIdentities,
    parseProvisionCliArgs,
    revalidateProvisionArtifacts,
    validateProvisionedCatalog,
    writeProvisionArtifacts
} from "./lib/provisionRoomWallets.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));

function resolveGitRoot() {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
        cwd: currentDir,
        encoding: "utf8"
    }).trim();
}

function restrictWindowsAcl(outputDir) {
    if (process.platform !== "win32") {
        return { attempted: false, ok: true, detail: "posix file modes used" };
    }

    try {
        execFileSync("icacls", [
            outputDir,
            "/inheritance:r",
            "/grant:r",
            `${process.env.USERNAME}:(OI)(CI)F`
        ], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"]
        });

        return { attempted: true, ok: true, detail: "NTFS ACL limited to current user" };
    } catch (error) {
        return {
            attempted: true,
            ok: false,
            detail: error?.stderr ? "icacls failed" : "icacls failed"
        };
    }
}

function printPublicSummary(summary) {
    for (const line of formatPublicSummaryLines(summary)) {
        console.log(line);
    }
}

async function main() {
    const parsedArgs = parseProvisionCliArgs(process.argv.slice(2));
    const outputDir = assertOutputDirSafe(parsedArgs.outputDir, resolveGitRoot(), {
        network: parsedArgs.network
    });
    await mkdir(outputDir, { recursive: true, mode: 0o700 });

    const acl = restrictWindowsAcl(outputDir);

    if (acl.attempted && !acl.ok) {
        throw new Error("refusing to generate wallets because the output directory ACL could not be restricted");
    }

    const identities = generateRoomWalletIdentities({ network: parsedArgs.network });
    validateProvisionedCatalog(identities, { envNetwork: parsedArgs.network });
    const written = await writeProvisionArtifacts(outputDir, {
        masterBackup: buildMasterBackup(identities),
        runtimePayload: buildRuntimePayload(identities),
        network: parsedArgs.network
    });

    const rereadStats = await revalidateProvisionArtifacts({
        masterPath: written.masterPath,
        runtimePath: written.runtimePath,
        expectedMasterSha256: written.masterSha256,
        expectedRuntimeSha256: written.runtimeSha256,
        network: parsedArgs.network
    });

    const runtimeBytes = await readFile(written.runtimePath, "utf8");

    const collector = new ConfigurationIssueCollector();
    validateSecrets(collector, {
        DEVELOPER_AUTH_ENABLED: "false",
        ROOM_WALLETS_JSON: runtimeBytes,
        ROOM_WALLET_PAYMENT_INTAKE_MODE: "ROOM_WALLET",
        TON_NETWORK: parsedArgs.network
    }, {
        nodeEnv: "development",
        tonDeployMode: "stub",
        developer: { enabled: false, configured: false }
    });
    collector.throwIfAny();

    loadRoomWalletRuntimeConfig({
        ROOM_WALLETS_JSON: runtimeBytes,
        ROOM_WALLET_PAYMENT_INTAKE_MODE: "ROOM_WALLET",
        TON_NETWORK: parsedArgs.network
    });

    printPublicSummary(buildPublicSummary(rereadStats, {
        masterPath: written.masterPath,
        runtimePath: written.runtimePath,
        masterSha256: written.masterSha256,
        runtimeSha256: written.runtimeSha256,
        acl: acl.detail
    }));
}

main().catch((error) => {
    const message = error instanceof Error ? error.message : "provisioning failed";
    console.error(message);
    process.exitCode = 1;
});
