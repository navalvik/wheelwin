/**
 * R17.8V.1C — Entry point for testnet ValueTon sweep (measurement only).
 *
 * Dry-run (default):
 *   node server/scripts/run-testnet-valueton-sweep.js
 *
 * Live testnet:
 *   RUN_TESTNET_VALUETON_SWEEP=true
 *   TON_NETWORK=testnet
 *   TON_DEPLOY_MODE=live
 *   TON_DEPLOYER_MNEMONIC="..."
 *   TEST_VALUETON_OVERRIDE=true
 *   node server/scripts/run-testnet-valueton-sweep.js
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));
const harness = join(currentDir, "..", "tests", "testnet", "runValueTonSweep.js");

if (String(process.env.TON_NETWORK || "").toLowerCase() === "mainnet") {

    console.error("[R17.8V.1C] Refusing to run on mainnet.");
    process.exit(1);

}

process.env.TON_NETWORK = process.env.TON_NETWORK || "testnet";

console.log("[R17.8V.1C] Testnet ValueTon sweep harness");

const result = spawnSync(process.execPath, [harness, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: process.env
});

process.exit(result.status ?? 1);
