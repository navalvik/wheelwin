/**
 * R17.8V.2I — probe get_status stack shape on a live escrow (no secrets logged).
 * Usage: node server/scripts/probe-v2i-status.js <contractAddress>
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const address = process.argv[2];
if (!address) {
    console.error("Usage: node probe-v2i-status.js <contractAddress>");
    process.exit(1);
}

const currentDir = dirname(fileURLToPath(import.meta.url));

function loadEnvFile(filePath) {
    if (!existsSync(filePath)) return;
    for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const index = trimmed.indexOf("=");
        if (index <= 0) continue;
        const key = trimmed.slice(0, index).trim();
        let value = trimmed.slice(index + 1).trim();
        if (
            (value.startsWith("\"") && value.endsWith("\""))
            || (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }
        if (process.env[key] === undefined) process.env[key] = value;
    }
}

loadEnvFile(resolve(currentDir, "../.env"));
process.env.TON_NETWORK = "testnet";

const { loadTonConfig } = await import("../config/ton.js");
const { TonService } = await import("../services/TonService.js");
const { TonGameContractAdapter } = await import(
    "../payment/TonGameContractAdapter.js"
);
const { GAME_ESCROW_MODE_GAME } = await import(
    "../payment/ton/buildGameEscrowStateInit.js"
);

const logger = {
    info() {}, warn() {}, error: (...a) => console.error(...a),
    debug() {}, startupLine() {}, decisionTrace() {}
};
const tonConfig = loadTonConfig();
const tonService = new TonService({ logger, tonConfig });
tonService.initialize();
const adapter = new TonGameContractAdapter({
    tonConfig: { ...tonConfig, gameEscrowMode: GAME_ESCROW_MODE_GAME },
    tonService,
    logger
});

const paidMask = Number(await adapter.getPaidMask(address));
const balanceTon = Number(await tonService.getBalance(address)) / 1e9;

let statusRaw = null;
let statusErr = null;
try {
    statusRaw = await tonService.runGetMethod(address, "get_status");
} catch (error) {
    statusErr = error?.message ?? String(error);
}

console.log(JSON.stringify({
    address,
    paidMask,
    balanceTon,
    statusErr,
    statusRaw
}, (_, value) => (typeof value === "bigint" ? value.toString() : value), 2));
