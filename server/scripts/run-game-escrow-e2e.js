/**
 * R7.66H — Run GameEscrow E2E validation (testnet path, GAME_ESCROW_MODE=game).
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));
const testFile = join(currentDir, "..", "tests", "gameEscrowE2E.test.js");

process.env.TON_NETWORK = process.env.TON_NETWORK || "testnet";
process.env.GAME_ESCROW_MODE = "game";

console.log("[R7.66H] GameEscrow E2E validation (testnet, mode=game)");

const result = spawnSync(process.execPath, [testFile], {
    stdio: "inherit",
    env: process.env
});

process.exit(result.status ?? 1);
