/**
 * R17.8V.2D.2 — RPC health + deployer balance (no secrets logged).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
const { deriveDeployerWalletIdentity } = await import(
    "../payment/ton/deriveDeployerWalletIdentity.js"
);

const tonConfig = loadTonConfig();
const logger = {
    info() {}, warn() {}, error() {}, debug() {}, startupLine() {}, decisionTrace() {}
};
const svc = new TonService({ logger, tonConfig });
svc.initialize();

const started = Date.now();
let rpcOk = false;
let rpcError = null;
let seqno = null;

const id = await deriveDeployerWalletIdentity({
    mnemonic: tonConfig.deployerMnemonic,
    network: "testnet"
});

try {
    seqno = await svc.getSeqno(id.address);
    rpcOk = true;
} catch (error) {
    rpcError = error?.message ?? String(error);
}

const balanceNano = await svc.getBalance(id.address).catch((error) => {
    if (!rpcError) rpcError = error?.message ?? String(error);
    return null;
});

const balanceTon = balanceNano == null ? null : Number(balanceNano) / 1e9;

console.log(JSON.stringify({
    stage: "R17.8V.2D.2_RPC_HEALTH",
    network: tonConfig.network,
    endpoint: tonConfig.endpoint ?? tonConfig.rpcEndpoint ?? null,
    rpcHealthy: rpcOk && balanceTon != null,
    rpcLatencyMs: Date.now() - started,
    seqno,
    balanceTon,
    addressMasked: `${id.address.slice(0, 6)}....${id.address.slice(-4)}`,
    rpcError
}, null, 2));

process.exit(rpcOk && balanceTon != null ? 0 : 2);
