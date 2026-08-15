/**
 * R17.8V.2A — Testnet ValueTon sweep environment audit (read-only).
 *
 * Does NOT broadcast, deploy, or send TON.
 * Never prints mnemonics / private keys / API secrets.
 *
 * Usage:
 *   node server/scripts/check-testnet-valueton-env.js
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
    PRODUCTION_ORACLE_VALUE_TON,
    TEST_VALUETON_ENV_KEYS,
    isTestValueTonOverrideEnabled,
    resolveOracleValueTon
} from "../payment/ton/testValueTonOverride.js";
import { deriveDeployerWalletIdentity } from "../payment/ton/deriveDeployerWalletIdentity.js";

const currentDir = dirname(fileURLToPath(import.meta.url));

const AUDIT_KEYS = [
    "TON_NETWORK",
    "TON_DEPLOY_MODE",
    "TON_ENDPOINT",
    "TON_API_KEY",
    "TON_DEPLOYER_MNEMONIC",
    "TON_DEPLOYER_EXPECTED_ADDRESS",
    "TON_ORACLE_ADDRESS",
    "TON_TESTNET_ORACLE_ADDRESS",
    "GAME_ESCROW_MODE",
    "TEST_VALUETON_OVERRIDE",
    "TEST_VALUETON_DEPLOY",
    "TEST_VALUETON_INIT",
    "TEST_VALUETON_OPEN",
    "TEST_VALUETON_CANCEL",
    "TEST_VALUETON_SETTLE",
    "RUN_TESTNET_VALUETON_SWEEP",
    "TEST_VALUETON_SWEEP_VALUES",
    "TEST_VALUETON_SCENARIOS",
    "TEST_VALUETON_STAKE_TON"
];

function loadEnvFile(filePath, into = {}) {

    if (!existsSync(filePath)) {

        return { exists: false, into };

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

        if (into[key] === undefined) {

            into[key] = value;

        }

    }

    return { exists: true, into };

}

function classify(env, key) {

    if (!(key in env) || env[key] === undefined) {

        return "MISSING";

    }

    const value = String(env[key]).trim();

    if (value === "") {

        return "MISSING";

    }

    if (key === "TON_NETWORK"
        && value.toLowerCase() !== "testnet"
        && value.toLowerCase() !== "mainnet") {

        return "INVALID FORMAT";

    }

    if (key === "TON_DEPLOY_MODE"
        && value.toLowerCase() !== "live"
        && value.toLowerCase() !== "stub") {

        return "INVALID FORMAT";

    }

    if (key === "TEST_VALUETON_OVERRIDE") {

        const normalized = value.toLowerCase();

        if (normalized !== "true" && normalized !== "false") {

            return "INVALID FORMAT";

        }

    }

    const numericKeys = new Set([
        "TEST_VALUETON_DEPLOY",
        "TEST_VALUETON_INIT",
        "TEST_VALUETON_OPEN",
        "TEST_VALUETON_CANCEL",
        "TEST_VALUETON_SETTLE",
        "TEST_VALUETON_STAKE_TON"
    ]);

    if (numericKeys.has(key)) {

        const numeric = Number(value);

        if (!Number.isFinite(numeric) || numeric <= 0) {

            return "INVALID FORMAT";

        }

    }

    return "FOUND";

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

function estimateBalances() {

    // Oracle attach baseline 0.05 × 4 (DEPLOY/INIT/OPEN/CANCEL) = 0.20
    // + fees cushion + player fund for B/C
    const oracleAttach = 0.05 * 4;
    const fees = 0.05;
    const stake = 0.05;
    const playerGas = 0.05;

    const scenarioA = oracleAttach + fees;
    const scenarioB = oracleAttach + fees + stake + playerGas;
    const scenarioC = oracleAttach + fees + 3 * (stake + playerGas);

    // Full sweep ≈ 7 values × (A+B+C) with early-stop; budget conservatively
    // for one full A+B+C pass at 0.05 plus headroom for lower retries.
    const onePass = scenarioA + scenarioB + scenarioC;
    const recommended = Math.ceil((onePass * 3 + 1) * 10) / 10;

    return {
        scenarioA: Number(scenarioA.toFixed(3)),
        scenarioB: Number(scenarioB.toFixed(3)),
        scenarioC: Number(scenarioC.toFixed(3)),
        onePassAbc: Number(onePass.toFixed(3)),
        minimumRecommendedTestnetBalance: recommended
    };

}

async function main() {

    const envPath = resolve(currentDir, "../.env");
    const examplePath = resolve(currentDir, "../.env.example");

    const example = loadEnvFile(examplePath);
    const local = loadEnvFile(envPath);
    const merged = { ...example.into, ...local.into, ...process.env };

    const report = {
        audit: "R17.8V.2A",
        auditedAt: new Date().toISOString(),
        files: {
            "server/.env": local.exists ? "FOUND" : "MISSING",
            "server/.env.example": example.exists ? "FOUND" : "MISSING"
        },
        variables: {},
        network: {},
        wallet: {
            walletConfigured: "NO",
            addressDerivation: "FAIL",
            addressMasked: null,
            walletType: "WalletContractV4R2"
        },
        harness: {},
        balanceEstimatesTon: estimateBalances(),
        readiness: "BLOCKED",
        missing: [],
        blockers: []
    };

    for (const key of AUDIT_KEYS) {

        report.variables[key] = {
            inEnvFile: local.exists ? classify(local.into, key) : "MISSING",
            inExample: example.exists ? classify(example.into, key) : "MISSING"
        };

    }

    const network = String(merged.TON_NETWORK || "").trim().toLowerCase();
    const deployMode = String(merged.TON_DEPLOY_MODE || "").trim().toLowerCase();

    report.network = {
        tonNetwork: network || null,
        expected: "testnet",
        matchesTestnet: network === "testnet",
        deployMode: deployMode || null,
        liveModeUnderstood: deployMode === "live" || deployMode === "stub",
        mainnetEnabled: network === "mainnet"
    };

    if (network !== "testnet") {

        report.blockers.push("TON_NETWORK must be testnet for ValueTon sweep");

    }

    if (network === "mainnet") {

        report.blockers.push("Mainnet is forbidden for this harness");

    }

    const mnemonicStatus = local.exists
        ? classify(local.into, "TON_DEPLOYER_MNEMONIC")
        : classify(merged, "TON_DEPLOYER_MNEMONIC");

    report.wallet.walletConfigured = mnemonicStatus === "FOUND" ? "YES" : "NO";

    if (mnemonicStatus === "FOUND") {

        try {

            const identity = await deriveDeployerWalletIdentity({
                mnemonic: merged.TON_DEPLOYER_MNEMONIC,
                network: "testnet"
            });

            report.wallet.addressDerivation = "PASS";
            report.wallet.addressMasked = maskAddress(identity.address);
            report.wallet.walletType = identity.walletContractType
                || "WalletContractV4R2";

        } catch {

            report.wallet.addressDerivation = "FAIL";
            report.blockers.push("Deployer address derivation failed");

        }

    } else {

        report.missing.push("TON_DEPLOYER_MNEMONIC");
        report.blockers.push("Deployer mnemonic not configured in server/.env");

    }

    if (!local.exists) {

        report.missing.push("server/.env");
        report.blockers.push("Create server/.env from .env.example with testnet secrets");

    }

    if (classify(merged, "TON_ENDPOINT") === "MISSING"
        && classify(merged, "TON_API_KEY") === "MISSING") {

        // Endpoint may default from profile; API key often needed for rate limits.
        report.missing.push("TON_API_KEY (recommended)");

    }

    report.harness = {
        overrideModule: "server/payment/ton/testValueTonOverride.js",
        productionBaselineTon: PRODUCTION_ORACLE_VALUE_TON,
        overrideEnabledNow: isTestValueTonOverrideEnabled(merged),
        defaultPathResolvesTo: resolveOracleValueTon("DEPLOY", {
            TEST_VALUETON_OVERRIDE: "false"
        }),
        overrideKeys: Object.values(TEST_VALUETON_ENV_KEYS),
        runner: "server/scripts/run-testnet-valueton-sweep.js",
        artifactsDir: "server/tests/testnet/artifacts/"
    };

    if (report.harness.defaultPathResolvesTo !== PRODUCTION_ORACLE_VALUE_TON) {

        report.blockers.push(
            `Production default resolver is not ${PRODUCTION_ORACLE_VALUE_TON}`
        );

    }

    if (report.blockers.length === 0) {

        report.readiness = "READY";

    }

    // Never dump secret values.
    console.log(JSON.stringify(report, null, 2));

    process.exit(report.readiness === "READY" ? 0 : 2);

}

main().catch((error) => {

    console.error(error?.message ?? error);
    process.exit(1);

});
