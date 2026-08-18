/**
 * R17.9L.14A — Safe TESTNET Deposit deployer readiness check.
 * Prints public identity only. Never prints mnemonic/private key/seed.
 * Does not send TON. Does not deploy.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { inspectTestnetDepositDeployerReadiness } from "../payment/ton/getTestnetDepositDeployer.js";

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

const snapshot = await inspectTestnetDepositDeployerReadiness(process.env);

logPublic("TON_NETWORK", snapshot.network || "<unset>");
logPublic("dedicatedTestnetCredentialConfigured", String(snapshot.dedicatedConfigured));
logPublic("productionCredentialConfigured", String(snapshot.productionConfigured));
logPublic("fallbackTestnetToProduction", "NO");
logPublic("credentialEqualityGuard", "YES");

if (snapshot.dedicatedConfigured && snapshot.dedicatedAddress) {

    process.stdout.write(
        `TESTNET DEPOSIT DEPLOYER ADDRESS:\n${snapshot.dedicatedAddress}\n`
    );

} else {

    process.stdout.write("DEDICATED TESTNET DEPLOYER:\nNOT CONFIGURED\n");

}

if (snapshot.productionAddress) {

    process.stdout.write(
        `PRODUCTION DEPLOY WALLET ADDRESS:\n${snapshot.productionAddress}\n`
    );

} else {

    process.stdout.write("PRODUCTION DEPLOY WALLET ADDRESS:\nNOT AVAILABLE\n");

}

logPublic("addressesIdentical", String(snapshot.addressesIdentical));
logPublic("liveDeploymentBlocked", String(snapshot.liveDeploymentBlocked));

if (snapshot.liveDeploymentBlocked) {

    process.stdout.write("R17.9L.14 LIVE DEPLOYMENT:\nREMAINS BLOCKED\n");
    process.exitCode = 2;

} else {

    process.stdout.write("R17.9L.14 LIVE DEPLOYMENT:\nCREDENTIAL READY\n");

}

process.stdout.write("NO TRANSACTION\n");
