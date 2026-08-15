/**
 * R17.8V.2F — verify paidMask/refundMask after a sweep run (no secrets).
 * Usage: node server/scripts/verify-v2f-refund.js <artifactJsonPath>
 */
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const artifactPath = process.argv[2];
if (!artifactPath) {
    console.error("Usage: node verify-v2f-refund.js <artifact>");
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

const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
const record = artifact.results?.[0];
if (!record?.contractAddress) {
    console.log(JSON.stringify({
        ok: false,
        classification: record?.success === false
            ? "see_harness_failure"
            : "missing_contract",
        harnessSuccess: record?.success ?? null,
        failureReason: record?.failureReason ?? null
    }, null, 2));
    process.exit(2);
}

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

const address = record.contractAddress;
const scenario = record.scenario;
const expectedPaid = scenario === "C" ? 7 : scenario === "B" ? 1 : 0;
const expectedRefund = expectedPaid;

const paidMask = Number(await adapter.getPaidMask(address));
const refundMask = Number(await adapter.getRefundMask(address));
let refundedTotal = null;
try {
    refundedTotal = (await adapter.getRefundedTotal(address)).toString();
} catch (error) {
    refundedTotal = error?.message ?? String(error);
}
const balanceNano = await tonService.getBalance(address);
const balanceTon = Number(balanceNano) / 1e9;

let classification = "PASS";
if (paidMask !== expectedPaid) {
    classification = "VALUETON_FAILURE_OR_INCOMPLETE";
}
if (expectedRefund > 0 && refundMask !== expectedRefund) {
    classification = "VALUETON_FAILURE";
}

const ok = classification === "PASS";

console.log(JSON.stringify({
    scenario,
    valueTon: record.valueTon,
    contract: address,
    harnessSuccess: record.success,
    harnessRefundMask: record.refundMask,
    onChain: {
        paidMask,
        refundMask,
        refundedTotal,
        remainingBalanceTon: balanceTon
    },
    expectedPaid,
    expectedRefund,
    classification,
    ok
}, null, 2));

process.exit(ok ? 0 : 3);
