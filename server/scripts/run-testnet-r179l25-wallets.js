/**
 * R17.9L.25.D — Read-only player wallet readiness (zero transactions).
 *
 * Requires local env:
 *   L25_PLAYER_{0,1,2}_MNEMONIC
 *   L25_PLAYER_{0,1,2}_ADDRESS
 *   TON_NETWORK=testnet
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
    printL25PlayerWalletReadinessReport,
    runL25PlayerWalletReadiness
} from "../tests/testnet/r179l25/l25PlayerWalletReadiness.js";
import { L25TestError } from "../tests/testnet/r179l25/l25Errors.js";

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
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "server/.env")
]) {

    loadEnvFile(candidate);

}

if (String(process.env.TON_NETWORK || "").toLowerCase() === "mainnet") {

    console.error("[R17.9L.25.D] Refusing wallet readiness on mainnet.");
    process.exit(1);

}

process.env.TON_NETWORK = process.env.TON_NETWORK || "testnet";

async function main() {

    try {

        const result = await runL25PlayerWalletReadiness({ env: process.env });

        printL25PlayerWalletReadinessReport(result);
        process.exit(result.verdict === "PLAYER_WALLETS_READY" ? 0 : 1);

    } catch (error) {

        if (error instanceof L25TestError) {

            process.stdout.write(`status=BLOCKED\ncode=${error.code}\nreason=${error.message}\n`);

            if (error.code === "READINESS_BLOCKED" || error.code === "ENV_MISSING") {

                process.stdout.write(
                    "hint=Configure L25_PLAYER_{0,1,2}_MNEMONIC and L25_PLAYER_{0,1,2}_ADDRESS in server/.env\n"
                );

            }

            process.exit(1);

        }

        throw error;

    }

}

await main();
