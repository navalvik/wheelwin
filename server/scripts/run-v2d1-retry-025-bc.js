/**
 * R17.8V.2D.1 — Retry B/C at 0.025 after TonCenter RPC failures.
 * Scenario A @ 0.025 already PASS. Runtime env only.
 */
process.env.TON_NETWORK = "testnet";
process.env.TON_DEPLOY_MODE = "live";
process.env.RUN_TESTNET_VALUETON_SWEEP = "true";
process.env.TEST_VALUETON_OVERRIDE = "true";
process.env.TEST_VALUETON_SWEEP_VALUES = "0.025";
process.env.TEST_VALUETON_SCENARIOS = "B,C";
process.env.TEST_VALUETON_STAKE_TON = "0.05";

console.log(
    "R17.8V.2D.1 retry 0.025 B,C | network=testnet | override=true"
);

const { main } = await import("../tests/testnet/runValueTonSweep.js");

await main([]);
