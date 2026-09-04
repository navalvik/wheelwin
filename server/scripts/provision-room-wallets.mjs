#!/usr/bin/env node
/**
 * One-time offline TESTNET Room Wallet provisioning.
 *
 * Usage:
 *   node scripts/provision-room-wallets.mjs --output-dir <absolute-path-outside-git>
 *
 * Writes two files into the output directory and prints only public metadata
 * and SHA-256 hashes. Never prints secretKey, mnemonic, or raw JSON.
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
    generateRoomWalletIdentities,
    hashFileSha256,
    validateProvisionedCatalog,
    writeProvisionArtifacts
} from "./lib/provisionRoomWallets.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));

function parseOutputDir(argv) {
    const index = argv.indexOf("--output-dir");

    if (index < 0 || !argv[index + 1] || argv[index + 1].startsWith("--")) {
        throw new Error("usage: node scripts/provision-room-wallets.mjs --output-dir <absolute-path-outside-git>");
    }

    return argv[index + 1];
}

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

async function revalidateArtifacts({ masterPath, runtimePath, expectedMasterSha256, expectedRuntimeSha256 }) {
    const masterBytes = await readFile(masterPath);
    const runtimeBytes = await readFile(runtimePath);
    const masterSha256 = await hashFileSha256(masterPath);
    const runtimeSha256 = await hashFileSha256(runtimePath);

    if (masterSha256 !== expectedMasterSha256 || runtimeSha256 !== expectedRuntimeSha256) {
        throw new Error("artifact hash mismatch after re-read");
    }

    const masterBackup = JSON.parse(masterBytes.toString("utf8"));
    const runtimePayload = JSON.parse(runtimeBytes.toString("utf8"));

    if (!Array.isArray(masterBackup.wallets) || masterBackup.wallets.length !== 64) {
        throw new Error("master backup did not re-read 64 wallets");
    }

    if (!Array.isArray(runtimePayload) || runtimePayload.length !== 64) {
        throw new Error("runtime JSON did not re-read 64 wallets");
    }

    const stats = validateProvisionedCatalog(masterBackup.wallets);
    const parsed = loadRoomWalletRuntimeConfig({
        ROOM_WALLETS_JSON: runtimeBytes.toString("utf8"),
        ROOM_WALLET_PAYMENT_INTAKE_MODE: "ROOM_WALLET",
        TON_NETWORK: "testnet"
    });

    const collector = new ConfigurationIssueCollector();
    validateSecrets(collector, {
        DEVELOPER_AUTH_ENABLED: "false",
        ROOM_WALLETS_JSON: runtimeBytes.toString("utf8"),
        ROOM_WALLET_PAYMENT_INTAKE_MODE: "ROOM_WALLET",
        TON_NETWORK: "testnet"
    }, {
        nodeEnv: "development",
        tonDeployMode: "stub",
        developer: { enabled: false, configured: false }
    });
    collector.throwIfAny();

    if (parsed.entries.length !== 64) {
        throw new Error("production parser did not accept the re-read runtime JSON");
    }

    return stats;
}

function printPublicSummary(summary) {
    console.log("Room Wallet offline provisioning complete.");
    console.log(`count=${summary.count}`);
    console.log(`network=${summary.network}`);
    console.log(`workchain=${summary.workchain}`);
    console.log(`walletContractType=${summary.walletContractType}`);
    console.log(`uniqueAddresses=${summary.uniqueAddresses}`);
    console.log(`uniquePublicKeys=${summary.uniquePublicKeys}`);
    console.log(`uniqueSecretKeys=${summary.uniqueSecretKeys}`);
    console.log(`masterBackup=${summary.artifacts.masterPath}`);
    console.log(`masterSha256=${summary.artifacts.masterSha256}`);
    console.log(`runtimeJson=${summary.artifacts.runtimePath}`);
    console.log(`runtimeSha256=${summary.artifacts.runtimeSha256}`);
    console.log(`acl=${summary.artifacts.acl}`);

    for (const room of summary.rooms) {
        console.log(`room=${String(room.roomNumber).padStart(2, "0")} address=${room.address}`);
    }
}

async function main() {
    const outputDir = assertOutputDirSafe(parseOutputDir(process.argv.slice(2)), resolveGitRoot());
    await mkdir(outputDir, { recursive: true, mode: 0o700 });

    const acl = restrictWindowsAcl(outputDir);

    if (acl.attempted && !acl.ok) {
        throw new Error("refusing to generate wallets because the output directory ACL could not be restricted");
    }

    const identities = generateRoomWalletIdentities();
    validateProvisionedCatalog(identities);
    const written = await writeProvisionArtifacts(outputDir, {
        masterBackup: buildMasterBackup(identities),
        runtimePayload: buildRuntimePayload(identities)
    });

    const rereadStats = await revalidateArtifacts({
        masterPath: written.masterPath,
        runtimePath: written.runtimePath,
        expectedMasterSha256: written.masterSha256,
        expectedRuntimeSha256: written.runtimeSha256
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
