/**
 * R7.68 — Mainnet readiness validation (does not enable Mainnet).
 *
 * Usage (from repo root or server/):
 *   node server/scripts/check-mainnet-readiness.js
 *
 * Exit 0 = PASS, 1 = FAIL.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
    evaluateMainnetReadiness,
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
        walletAddress: identity.address,
        balanceTon,
        balanceNano,
        seqno
    };

}

async function main() {

    const profile = loadMainnetTonProfile(process.env);
    const wallet = await probeWallet(profile);

    const readiness = evaluateMainnetReadiness({
        env: process.env,
        activeNetwork: process.env.TON_NETWORK || null,
        walletType: wallet.walletType,
        walletAddress: wallet.walletAddress,
        balanceTon: wallet.balanceTon,
        balanceNano: wallet.balanceNano,
        seqno: wallet.seqno,
        requireLiveWallet: Boolean(process.env.TON_DEPLOYER_MNEMONIC?.trim())
    });

    setTonMainnetReadiness(readiness);
    printTonMainnetReadiness();

    console.log("");
    console.log(readiness.status);

    if (readiness.reasons.length > 0) {

        console.log("reasons:");

        for (const reason of readiness.reasons) {

            console.log(`  - ${reason}`);

        }

    }

    console.log("");
    console.log("checks:");
    console.log(`  wallet identity: ${
        readiness.identityMatch === true
            ? "PASS"
            : readiness.identityMatch === false
                ? "FAIL"
                : "SKIP"
    }`);
    console.log(`  balance: ${
        readiness.balanceTon != null ? `PASS (${readiness.balanceTon} TON)` : "SKIP"
    }`);
    console.log(`  artifact: ${
        readiness.artifactMatch === true
            ? "PASS"
            : readiness.artifactHash
                ? "FAIL"
                : "FAIL"
    }`);
    console.log(`  config: ${
        readiness.oracleAddress && readiness.expectedAddress && readiness.endpoint
            ? "PASS"
            : "FAIL"
    }`);
    console.log(`  rollback availability: ${
        readiness.rollbackAvailable ? "PASS (v4)" : "FAIL"
    }`);

    process.exit(readiness.status === "PASS" ? 0 : 1);

}

main().catch((error) => {

    console.error("FAIL");
    console.error(error);
    process.exit(1);

});
