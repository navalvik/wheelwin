/**
 * R17.8V.2I — Resume SETTLE on an already READY escrow (testnet only).
 * Completes validation after harness status-parse flake; does not change production.
 *
 * Usage:
 *   node server/scripts/resume-v2i-settle.js
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
process.env.TON_DEPLOY_MODE = "live";
process.env.TEST_VALUETON_OVERRIDE = "true";
process.env.TEST_VALUETON_SETTLE = "0.022";
process.env.TEST_VALUETON_DEPLOY = "0.022";
process.env.TEST_VALUETON_INIT = "0.022";
process.env.TEST_VALUETON_OPEN = "0.022";
process.env.TEST_VALUETON_CANCEL = "0.022";

const artifactPath = resolve(
    currentDir,
    "../tests/testnet/artifacts/valueton-sweep-v2i-022-S.json"
);
const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
const record = artifact.results?.[0];
if (!record?.contractAddress) {
    console.error("Missing contract in artifact");
    process.exit(1);
}

const contractAddress = record.contractAddress;
const contractId = "contract_v1c_S_0p022_1786808823350";
const snapshotHash =
    "f1dcb88f894b198aa4498db5695d8191807026af8eac98c89473bba4ed10dcba";
const winnerWallet = "EQBSMoJWjkmhO_GjuUuD1mMG5-t_pZI4Izaxh8FJbwahJP9O";
const totalPot = 0.15;
const organizerFee = 0.0075;
const winnerAmount = 0.1425;
const ownerAmount = organizerFee;
const settleGasReserveTon = 0.05;

const { loadTonConfig } = await import("../config/ton.js");
const { TonService } = await import("../services/TonService.js");
const { TonGameContractAdapter } = await import(
    "../payment/TonGameContractAdapter.js"
);
const { GAME_ESCROW_MODE_GAME } = await import(
    "../payment/ton/buildGameEscrowStateInit.js"
);
const { resolveOracleValueTon } = await import(
    "../payment/ton/testValueTonOverride.js"
);
const { verifyGameEscrowPayouts } = await import(
    "../payment/ton/verifyGameEscrowPayouts.js"
);
const { deriveDeployerWalletIdentity } = await import(
    "../payment/ton/deriveDeployerWalletIdentity.js"
);

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function normalizeGetStack(result) {
    const stack = result?.stack;
    if (Array.isArray(stack)) return stack;
    if (Array.isArray(stack?.items)) return stack.items;
    return [];
}

function stackItemRaw(item) {
    if (item == null) return null;
    if (Array.isArray(item) && item.length >= 2) return item[1];
    return item?.value ?? item?.num ?? item;
}

async function readStatusCode(tonService, address) {
    const result = await tonService.runGetMethod(address, "get_status");
    const raw = stackItemRaw(normalizeGetStack(result)[0]);
    if (raw == null) return null;
    const code = Number(
        typeof raw === "bigint" ? raw : String(raw).replace(/^0x/i, "")
    );
    return Number.isFinite(code) ? code : null;
}

async function readSettlementInfo(tonService, address) {
    const result = await tonService.runGetMethod(address, "get_settlement_info");
    let stack = normalizeGetStack(result);
    if (
        stack.length === 1
        && (Array.isArray(stack[0]?.tuple) || Array.isArray(stack[0]?.items))
    ) {
        stack = stack[0].tuple ?? stack[0].items;
    }
    const toTon = (raw) => {
        if (raw == null) return null;
        const nano = typeof raw === "bigint"
            ? raw
            : BigInt(String(stackItemRaw(raw) ?? raw).replace(/^0x/i, ""));
        return Number(nano) / 1e9;
    };
    const settledRaw = stackItemRaw(stack[3]);
    return {
        winnerAmountTon: toTon(stack[1]),
        ownerAmountTon: toTon(stack[2]),
        settled: Number(settledRaw) === 1
    };
}

const logger = {
    info: (...a) => console.log("[V2I-RESUME]", ...a),
    warn: (...a) => console.warn("[V2I-RESUME]", ...a),
    error: (...a) => console.error("[V2I-RESUME]", ...a),
    debug() {},
    startupLine() {},
    decisionTrace() {}
};

const tonConfig = loadTonConfig();
const tonService = new TonService({ logger, tonConfig });
tonService.initialize();
const adapter = new TonGameContractAdapter({
    tonConfig: { ...tonConfig, gameEscrowMode: GAME_ESCROW_MODE_GAME },
    tonService,
    logger
});

const identity = await deriveDeployerWalletIdentity({
    mnemonic: tonConfig.deployerMnemonic,
    network: "testnet"
});
const ownerWallet = identity.address;

const paidMask = Number(await adapter.getPaidMask(contractAddress));
const statusBefore = await readStatusCode(tonService, contractAddress);
const balanceBeforeSettleTon =
    Number(await tonService.getBalance(contractAddress)) / 1e9;
const deployerBefore =
    Number(await tonService.getBalance(ownerWallet)) / 1e9;

const requiredBalanceTon = winnerAmount + ownerAmount + settleGasReserveTon;
const actualHeadroomTon = Number(
    (balanceBeforeSettleTon - requiredBalanceTon).toFixed(9)
);

logger.info(JSON.stringify({
    contractAddress,
    paidMask,
    statusBefore,
    balanceBeforeSettleTon,
    requiredBalanceTon,
    actualHeadroomTon,
    settleValueTon: resolveOracleValueTon("SETTLE")
}));

if (paidMask !== 7 || statusBefore !== 5) {
    console.error(JSON.stringify({
        ok: false,
        classification: "HARNESS_FAILURE",
        reason: `precondition failed paidMask=${paidMask} status=${statusBefore}`
    }, null, 2));
    process.exit(2);
}

const settle = await adapter.settle({
    contractId,
    contractAddress,
    winnerWallet,
    ownerWallet,
    winnerAmount,
    organizerAmount: ownerAmount,
    ownerAmount,
    snapshotHash
});

await sleep(15000);

const statusAfter = await readStatusCode(tonService, contractAddress);
let settlementInfo = null;
try {
    settlementInfo = await readSettlementInfo(tonService, contractAddress);
} catch (error) {
    settlementInfo = { error: error?.message ?? String(error) };
}

const remainingBalanceTon =
    Number(await tonService.getBalance(contractAddress)) / 1e9;
const deployerAfter =
    Number(await tonService.getBalance(ownerWallet)) / 1e9;

let payoutVerify = null;
try {
    const txs = await tonService.getTransactions(contractAddress, { limit: 20 });
    payoutVerify = verifyGameEscrowPayouts({
        transactions: txs,
        winnerAddress: winnerWallet,
        ownerAddress: ownerWallet,
        winnerAmount,
        ownerAmount,
        settleTxHash: settle?.txId ?? null,
        contractStatus: statusAfter
    });
} catch (error) {
    payoutVerify = { ok: false, reason: error?.message ?? String(error) };
}

const amountsMatch = settlementInfo?.winnerAmountTon != null
    && Math.abs(Number(settlementInfo.winnerAmountTon) - winnerAmount) < 1e-6
    && Math.abs(Number(settlementInfo.ownerAmountTon) - ownerAmount) < 1e-6;

const success = settle?.ok === true
    && statusAfter === 8
    && (amountsMatch || payoutVerify?.ok === true);

const classification = success
    ? "PASS"
    : (actualHeadroomTon < 0 ? "VALUETON_FAILURE" : "VALUETON_FAILURE");

record.steps.push({
    step: "SETTLE_RESUME",
    ok: settle?.ok === true,
    txId: settle?.txId ?? null,
    configuredValueTon: resolveOracleValueTon("SETTLE"),
    reason: settle?.reason ?? null,
    at: new Date().toISOString()
});
record.steps.push({
    step: "SETTLE_PRECHECK",
    ok: true,
    balanceBeforeSettleTon,
    winnerAmountTon: winnerAmount,
    ownerAmountTon: ownerAmount,
    settleGasReserveTon,
    requiredBalanceTon,
    actualHeadroomTon,
    configuredValueTon: resolveOracleValueTon("SETTLE"),
    at: new Date().toISOString()
});
record.steps.push({
    step: "SETTLE_VERIFY",
    ok: success,
    statusCode: statusAfter,
    amountsMatch,
    settlementInfo,
    payoutVerify,
    at: new Date().toISOString()
});

record.success = success;
record.failureReason = success ? null : `resume settle status=${statusAfter}`;
record.failureClassification = classification;
record.balanceBeforeSettleTon = balanceBeforeSettleTon;
record.winnerAmountTon = winnerAmount;
record.ownerAmountTon = ownerAmount;
record.totalPotTon = totalPot;
record.organizerFeeTon = organizerFee;
record.settleGasReserveTon = settleGasReserveTon;
record.requiredBalanceTon = requiredBalanceTon;
record.actualHeadroomTon = actualHeadroomTon;
record.settlementInfo = settlementInfo;
record.finalStatus = {
    statusCode: statusAfter,
    statusName: statusAfter === 8 ? "SETTLED" : String(statusAfter),
    settlementInfo
};
record.remainingBalanceTon = remainingBalanceTon;
record.deployerBalanceAfterTon = deployerAfter;
record.totalTonSpentApprox = Number(
    (deployerBefore - deployerAfter).toFixed(9)
);
record.resumeNote =
    "SETTLE resumed on READY escrow after get_status stack.items parse fix";

artifact.executedAt = new Date().toISOString();
artifact.resume = {
    stage: "R17.8V.2I_RESUME_SETTLE",
    classification,
    success
};

writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
writeFileSync(
    join(dirname(artifactPath), "valueton-sweep-last-run.json"),
    `${JSON.stringify(artifact, null, 2)}\n`,
    "utf8"
);

console.log(JSON.stringify({
    stage: "R17.8V.2I_RESUME",
    classification,
    success,
    contractAddress,
    settleTxId: settle?.txId ?? null,
    statusBefore,
    statusAfter,
    balanceBeforeSettleTon,
    requiredBalanceTon,
    actualHeadroomTon,
    winnerAmountTon: winnerAmount,
    ownerAmountTon: ownerAmount,
    settlementInfo,
    payoutVerify,
    remainingBalanceTon,
    remainingDeployerBalanceTon: deployerAfter,
    totalTonSpentApprox: record.totalTonSpentApprox,
    artifactPath,
    productionBaselineTon: "0.05"
}, null, 2));

process.exit(success ? 0 : 2);
