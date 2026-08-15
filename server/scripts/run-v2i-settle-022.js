/**
 * R17.8V.2I — Live 0.022 TON SETTLE validation (testnet measurement only).
 *
 * Lifecycle ValueTon = 0.022; player stake remains 0.05 × 3.
 * Production default valueTon is NOT changed.
 *
 * Usage:
 *   node server/scripts/run-v2i-settle-022.js
 */
process.env.TON_NETWORK = "testnet";
process.env.TON_DEPLOY_MODE = "live";
process.env.RUN_TESTNET_VALUETON_SWEEP = "true";
process.env.TEST_VALUETON_OVERRIDE = "true";
process.env.TEST_VALUETON_SWEEP_VALUES = "0.022";
process.env.TEST_VALUETON_SCENARIOS = "S";
process.env.TEST_VALUETON_STAKE_TON = "0.05";

if (process.env.TON_NETWORK !== "testnet") {
    console.error("STOP: TON_NETWORK must be testnet");
    process.exit(1);
}

if (process.env.TEST_VALUETON_OVERRIDE !== "true") {
    console.error("STOP: TEST_VALUETON_OVERRIDE must be true");
    process.exit(1);
}

console.log(
    "R17.8V.2I preflight OK | network=testnet | value=0.022 | scenario=S (SETTLE) | stake=0.05"
);

const { main } = await import("../tests/testnet/runValueTonSweep.js");
const report = await main([]);

const record = report?.results?.[0] ?? null;
const outDir = new URL("../tests/testnet/artifacts/", import.meta.url);
const { writeFileSync, mkdirSync } = await import("node:fs");
const { fileURLToPath } = await import("node:url");
const { join } = await import("node:path");

const artifactsDir = fileURLToPath(outDir);
mkdirSync(artifactsDir, { recursive: true });
const artifactPath = join(artifactsDir, "valueton-sweep-v2i-022-S.json");
writeFileSync(artifactPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

console.log(JSON.stringify({
    stage: "R17.8V.2I",
    classification: record?.failureClassification
        ?? (record?.success ? "PASS" : "UNKNOWN"),
    success: record?.success ?? false,
    contractAddress: record?.contractAddress ?? null,
    balanceBeforeSettleTon: record?.balanceBeforeSettleTon ?? null,
    requiredBalanceTon: record?.requiredBalanceTon ?? null,
    actualHeadroomTon: record?.actualHeadroomTon ?? null,
    winnerAmountTon: record?.winnerAmountTon ?? null,
    ownerAmountTon: record?.ownerAmountTon ?? null,
    finalStatus: record?.finalStatus ?? null,
    remainingDeployerBalanceTon: record?.deployerBalanceAfterTon ?? null,
    totalTonSpentApprox: record?.totalTonSpentApprox ?? null,
    artifactPath,
    productionBaselineTon: report?.productionBaselineTon ?? "0.05"
}, null, 2));

if (!record?.success) {
    process.exit(2);
}
