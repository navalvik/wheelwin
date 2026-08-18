/**
 * R17.9L.14 — TESTNET Deposit Contract deploy + read-only verification.
 *
 * Uses TON_TESTNET_DEPOSIT_DEPLOYER_MNEMONIC only.
 * Does NOT use TON_DEPLOYER_MNEMONIC / WheelWin Deploy Wallet.
 * Does NOT deploy Game Contract. Does NOT send FundSeat.
 * R17.9L.14A: configuration remains fail-closed; this script never sends TON.
 *
 * Usage:
 *   node server/scripts/r179l14_deploy_deposit_testnet.mjs
 *
 * Live send requires dedicated:
 *   TON_TESTNET_DEPOSIT_DEPLOYER_MNEMONIC
 * and explicit:
 *   --execute
 * (execute remains reserved until R17.9L.14 live deploy is unblocked)
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
    assertDedicatedTestnetDepositDeployer,
    assertTestnetNetworkConfig,
    DepositTestnetDeployError,
    prepareDepositTestnetDeployPlan,
    TESTNET_DEPLOYMENT_CREDENTIAL_REQUIRED,
    toPublicDeployPlan
} from "../payment/ton/depositTestnetDeploy.js";
import {
    FROZEN_DEPOSIT_ARTIFACT_SHA256,
    TESTNET_DEPOSIT_DEPLOYER_MNEMONIC_ENV
} from "../payment/ton/depositTestnetFixture.js";
import {
    TESTNET_DEPOSIT_DEPLOYER_CREDENTIAL_REQUIRED,
    getTestnetDepositDeployer
} from "../payment/ton/getTestnetDepositDeployer.js";

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

function logPublic(label, value) {

    process.stdout.write(`${label}=${value}\n`);

}

function isMissingDedicatedCredential(error) {

    return error instanceof DepositTestnetDeployError
        && (
            error.code === TESTNET_DEPOSIT_DEPLOYER_CREDENTIAL_REQUIRED
            || error.code === "TESTNET_DEPLOYMENT_CREDENTIAL_REQUIRED"
        );

}

async function main() {

    const execute = process.argv.includes("--execute");

    process.stdout.write("R17.9L.14 TESTNET Deposit deploy (read-only first)\n");

    const network = assertTestnetNetworkConfig(process.env);

    logPublic("network", network.network);
    logPublic("endpointHost", new URL(network.endpoint).host);
    logPublic("artifactSha256Expected", FROZEN_DEPOSIT_ARTIFACT_SHA256);
    logPublic("executeRequested", String(execute));

    const plan = prepareDepositTestnetDeployPlan({ env: process.env });
    const publicPlan = toPublicDeployPlan(plan);

    for (const [key, value] of Object.entries(publicPlan)) {

        logPublic(key, value);

    }

    try {

        assertDedicatedTestnetDepositDeployer(process.env);

    } catch (error) {

        if (isMissingDedicatedCredential(error)) {

            process.stdout.write(`${TESTNET_DEPLOYMENT_CREDENTIAL_REQUIRED}\n`);
            process.stdout.write(`${TESTNET_DEPOSIT_DEPLOYER_CREDENTIAL_REQUIRED}\n`);
            process.stdout.write(
                `Set ${TESTNET_DEPOSIT_DEPLOYER_MNEMONIC_ENV} to a TESTNET-ONLY `
                    + "credential that is not TON_DEPLOYER_MNEMONIC.\n"
            );
            process.stdout.write("NO TRANSACTION\n");
            process.exitCode = 2;

            return;

        }

        throw error;

    }

    const deployer = await getTestnetDepositDeployer(process.env);

    logPublic("testnetDepositDeployerRole", deployer.role);
    logPublic("testnetDepositDeployerAddress", deployer.walletAddress);
    logPublic("testnetDepositDeployerWalletVersion", deployer.walletVersion);
    logPublic("testnetDepositDeployerWorkchain", String(deployer.workchain));

    if (!execute) {

        process.stdout.write(
            "Credential present. Dry-run only (pass --execute to send testnet TON).\n"
        );
        process.stdout.write("NO TRANSACTION\n");

        return;

    }

    process.stdout.write(
        "Live execute path is reserved until dedicated testnet deployer readiness is complete.\n"
    );
    process.stdout.write("NO TRANSACTION\n");
    process.exitCode = 2;

}

main().catch((error) => {

    process.stderr.write(`${error?.message ?? error}\n`);
    process.stdout.write("NO TRANSACTION\n");
    process.exitCode = 1;

});
