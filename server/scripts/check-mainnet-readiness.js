/**
 * R7.68 / R8.1A — Mainnet dry-run readiness validation (does not enable Mainnet).
 *
 * Usage (from repo root or server/):
 *   node server/scripts/check-mainnet-readiness.js
 *
 * Exit 0 = PASS, 1 = FAIL.
 *
 * Optional:
 *   TON_MAINNET_DRY_RUN_DEBUG=true  — print TON_MAINNET_DRY_RUN_DEBUG block
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
    evaluateMainnetReadiness,
    printTonMainnetDryRunDebug,
    printTonMainnetReadiness,
    setTonMainnetReadiness
} from "../diagnostics/TonMainnetReadiness.js";
import { deriveDeployerWalletIdentity } from "../payment/ton/deriveDeployerWalletIdentity.js";
import { TonService } from "../services/TonService.js";
import { loadMainnetTonProfile } from "../config/tonNetworkProfiles.js";

const currentDir = dirname(fileURLToPath(import.meta.url));

function loadEnvFile(filePath) {

    if (!existsSync(filePath)) {

        return;

    }

    const text = readFileSync(filePath, "utf8");

    for (const line of text.split(/\r?\n/)) {

        const trimmed = line.trim();

        if (!trimmed || trimmed.startsWith("#")) {

            continue;

        }

        const index = trimmed.indexOf("=");

        if (index <= 0) {

            continue;

        }

        const key = trimmed.slice(0, index).trim();
        let value = trimmed.slice(index + 1).trim();

        if (
            (value.startsWith("\"") && value.endsWith("\""))
            || (value.startsWith("'") && value.endsWith("'"))
        ) {

            value = value.slice(1, -1);

        }

        if (process.env[key] === undefined) {

            process.env[key] = value;

        }

    }

}

for (const candidate of [
    resolve(currentDir, "../.env"),
    resolve(currentDir, "../.env.local"),
    resolve(currentDir, "../../.env"),
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "server/.env")
]) {

    loadEnvFile(candidate);

}

async function probeWallet(profile) {

    const mnemonic = process.env.TON_DEPLOYER_MNEMONIC?.trim() || null;

    if (!mnemonic) {

        return {
            walletType: null,
            workchain: null,
            walletId: null,
            walletAddress: null,
            balanceTon: null,
            balanceNano: null,
            seqno: null
        };

    }

    const identity = await deriveDeployerWalletIdentity({
        mnemonic,
        network: "mainnet"
    });

    let balanceTon = null;
    let balanceNano = null;
    let seqno = null;

    const tonService = new TonService({
        logger: {
            info() {},
            warn() {},
            error() {},
            debug() {}
        },
        tonConfig: {
            network: "mainnet",
            endpoint: profile.endpoint,
            apiKey: process.env.TON_API_KEY || null,
            pollIntervalMs: 2000,
            deployMode: "stub",
            gameEscrowMode: profile.gameEscrowMode
        }
    });

    try {

        tonService.initialize();

        try {

            const nano = await tonService.getBalance(identity.address);

            balanceNano = String(nano);
            balanceTon = Number(nano) / 1e9;

        } catch {

            // RPC may be unavailable offline — still report identity.
        }

        try {

            seqno = await tonService.getSeqno(identity.address);

        } catch {

            seqno = null;

        }

    } finally {

        try {

            tonService.shutdown?.();

        } catch {

            // ignore
        }

    }

    return {
        walletType: identity.walletContractType,
        workchain: identity.workchain,
        walletId: identity.walletId,
        walletAddress: identity.address,
        balanceTon,
        balanceNano,
        seqno
    };

}

/**
 * @param {string} label
 * @param {"PASS"|"FAIL"|"SKIP"|string} status
 * @param {string} [detail]
 */
function printCheck(label, status, detail = "") {

    const suffix = detail ? ` — ${detail}` : "";
    console.log(`  ${label}: ${status}${suffix}`);

}

async function main() {

    const profile = loadMainnetTonProfile(process.env);
    const wallet = await probeWallet(profile);
    const requireLiveWallet = Boolean(process.env.TON_DEPLOYER_MNEMONIC?.trim());

    const readiness = evaluateMainnetReadiness({
        env: process.env,
        activeNetwork: process.env.TON_NETWORK || null,
        walletType: wallet.walletType,
        workchain: wallet.workchain,
        walletId: wallet.walletId,
        walletAddress: wallet.walletAddress,
        balanceTon: wallet.balanceTon,
        balanceNano: wallet.balanceNano,
        seqno: wallet.seqno,
        requireLiveWallet
    });

    setTonMainnetReadiness(readiness);
    printTonMainnetReadiness();
    printTonMainnetDryRunDebug(readiness);

    console.log("");
    console.log("=== R8.1A Mainnet Dry-Run Readiness ===");
    console.log(readiness.status === "PASS" ? "PASS" : "FAIL");

    if (readiness.reasons.length > 0) {

        console.log("reasons:");

        for (const reason of readiness.reasons) {

            console.log(`  - ${reason}`);

        }

    }

    const checks = readiness.checks ?? {};

    console.log("");
    console.log("checks:");
    printCheck(
        "configuration",
        checks.configuration ?? "FAIL",
        readiness.endpoint ? readiness.endpoint : "endpoint missing"
    );
    printCheck(
        "wallet identity",
        checks.walletIdentity ?? "SKIP",
        readiness.identityMatch === true
            ? `${readiness.walletType} ${readiness.walletAddress}`
            : readiness.identityMatch === false
                ? `mismatch derived=${readiness.walletAddress} expected=${readiness.expectedAddress}`
                : readiness.expectedAddress
                    ? (requireLiveWallet
                        ? "mnemonic/identity incomplete"
                        : "no mnemonic (SKIP)")
                    : "expected address not configured (SKIP)"
    );
    printCheck(
        "artifact",
        checks.artifact ?? "FAIL",
        readiness.artifactMatch === true && readiness.artifactLoadable === true
            ? `sha256=${readiness.artifactHash} loadable=true`
            : readiness.artifactHash
                ? `hash/loadable check failed`
                : "artifact missing"
    );
    printCheck(
        "network profile",
        checks.networkProfile ?? "FAIL",
        `network=${readiness.network} escrow=${readiness.escrowMode}`
    );
    printCheck(
        "rollback safety",
        checks.rollbackSafety ?? "FAIL",
        readiness.rollbackAvailable
            ? "Mainnet still v4 / GameEscrow not production-enabled"
            : "Mainnet GameEscrow must remain disabled (expect v4)"
    );

    if (readiness.balanceAvailable) {

        printCheck(
            "wallet balance",
            "PASS",
            `${readiness.balanceTon} TON`
        );

    } else if (requireLiveWallet) {

        printCheck(
            "wallet balance",
            "SKIP",
            "RPC balance unavailable (identity still validated)"
        );

    }

    console.log("");
    console.log(
        `validationTimestamp=${new Date(readiness.validationTimestamp).toISOString()}`
    );

    process.exit(readiness.status === "PASS" ? 0 : 1);

}

main().catch((error) => {

    console.error("FAIL");
    console.error(error);
    process.exit(1);

});
