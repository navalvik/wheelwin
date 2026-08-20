/**
 * R17.9L.25 — Opt-in entry for live testnet player Deposit E2E.
 *
 * Dry / disabled (default):
 *   npm run testnet:r179l25
 *
 * Live:
 *   RUN_TESTNET_R179L25=true npm run testnet:r179l25
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));
const harness = join(
    currentDir,
    "..",
    "tests",
    "testnet",
    "r179l25",
    "depositPlayerDeploymentE2E.r179l25.js"
);

if (String(process.env.TON_NETWORK || "").toLowerCase() === "mainnet") {

    console.error("[R17.9L.25] Refusing to run on mainnet.");
    process.exit(1);

}

process.env.TON_NETWORK = process.env.TON_NETWORK || "testnet";

console.log("[R17.9L.25] Testnet player deployment E2E harness");

const result = spawnSync(process.execPath, [harness, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: process.env
});

process.exit(result.status ?? 1);
