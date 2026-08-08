/**
 * R7.70B — Testnet wallet readiness check (no deploy / no stake / no settle).
 *
 * Usage:
 *   node server/scripts/check-testnet-wallet-readiness.js
 *
 * Exit 0 = READY, 1 = BLOCKED.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { OwnerConfiguration } from "../config/OwnerConfiguration.js";
import { loadTonConfig } from "../config/ton.js";
import {
    evaluateTonTestnetWalletReadiness,
    printTonTestnetWalletReadiness,
    setTonTestnetWalletReadiness
} from "../diagnostics/TonTestnetWalletReadiness.js";
import { deriveDeployerWalletIdentity } from "../payment/ton/deriveDeployerWalletIdentity.js";
import { TonService } from "../services/TonService.js";

const currentDir = dirname(fileURLToPath(import.meta.url));

function loadEnvFile(filePath) {

    if (!existsSync(filePath)) {

        return;

    }

    for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {

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
    resolve(currentDir, "../../.env"),
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "server/.env")
]) {

    loadEnvFile(candidate);

}

function maskAddress(value) {

    if (!value) {

        return null;

    }

    const text = String(value);

    if (text.length < 12) {

        return text;

    }

    return `${text.slice(0, 6)}....${text.slice(-4)}`;

}

async function probeBalance(tonConfig, address) {

    if (!address) {

        return null;

    }

    const tonService = new TonService({
        logger: {
            info() {},
            warn() {},
            error() {},
            debug() {}
        },
        tonConfig
    });

    try {

        tonService.initialize();
        const nano = await tonService.getBalance(address);

        return Number(nano) / 1e9;

    } catch {

        return null;

    } finally {

        try {

            tonService.shutdown?.();

        } catch {

            // ignore
        }

    }

}

async function main() {

    const tonConfig = loadTonConfig(process.env);
    const mnemonic = process.env.TON_DEPLOYER_MNEMONIC?.trim() || null;

    let deployAddress = null;
    let deployWalletId = null;

    if (mnemonic) {

        const identity = await deriveDeployerWalletIdentity({
            mnemonic,
            network: "testnet"
        });

        deployAddress = identity.address;
        deployWalletId = identity.walletId;

    }

    let ownerAddress = null;

    try {

        if (OwnerConfiguration._frozen) {

            OwnerConfiguration._frozen = null;

        }

        const owner = OwnerConfiguration.load({ env: process.env });

        ownerAddress = owner.ownerWallet ?? null;

    } catch {

        ownerAddress = null;

    }

    const deployBalanceTon = await probeBalance(tonConfig, deployAddress);
    const ownerBalanceTon = await probeBalance(tonConfig, ownerAddress);

    const readiness = evaluateTonTestnetWalletReadiness({
        network: tonConfig.network,
        gameEscrowMode: tonConfig.gameEscrowMode,
        deployAddress,
        deployWalletId,
        deployBalanceTon,
        oracleAddress: tonConfig.oracleAddress,
        oracleSource: tonConfig.oracleSource,
        ownerAddress,
        ownerBalanceTon
    });

    setTonTestnetWalletReadiness(readiness);
    printTonTestnetWalletReadiness(readiness);

    console.log("");
    console.log("=== R7.70B Testnet Wallet Readiness ===");
    console.log(readiness.status === "READY" ? "READY" : "BLOCKED");
    console.log(`network=${readiness.network}`);
    console.log(`mode=${readiness.mode}`);
    console.log(`stake=${readiness.stakeGram} Gram (expected total ${readiness.expectedTotalGram} Gram)`);
    console.log(`deploy=${maskAddress(readiness.deployAddress)} walletId=${readiness.deployWalletId}`);
    console.log(`deployBalance=${readiness.deployBalanceTon ?? "n/a"} TON`);
    console.log(`oracle=${maskAddress(readiness.oracleAddress)} source=${readiness.oracleSource}`);
    console.log(`owner=${maskAddress(readiness.ownerAddress)} balance=${readiness.ownerBalanceTon ?? "n/a"} TON`);
    console.log(`players=${readiness.playersConfigured} seats=${readiness.playerSeatCount}`);

    if (readiness.reasons.length > 0) {

        console.log("reasons:");

        for (const reason of readiness.reasons) {

            console.log(`  - ${reason}`);

        }

    }

    process.exit(readiness.status === "READY" ? 0 : 1);

}

main().catch((error) => {

    console.error("BLOCKED");
    console.error(error);
    process.exit(1);

});
