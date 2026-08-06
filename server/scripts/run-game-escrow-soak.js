/**
 * R7.66I — Run GameEscrow soak validation (testnet, GAME_ESCROW_MODE=game).
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));
const testFile = join(currentDir, "..", "tests", "gameEscrowSoak.test.js");

process.env.TON_NETWORK = process.env.TON_NETWORK || "testnet";
process.env.GAME_ESCROW_MODE = "game";

if (String(process.env.TON_NETWORK).toLowerCase() === "mainnet") {

    console.error("[R7.66I] Refusing to run soak validation on mainnet.");
    process.exit(1);

}

console.log("[R7.66I] GameEscrow soak validation (testnet, mode=game)");

const result = spawnSync(process.execPath, [testFile], {
    stdio: "inherit",
    env: process.env
});

process.exit(result.status ?? 1);
