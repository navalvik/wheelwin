/**
 * R17.8V.2D.1 — Retry Scenario B only at 0.025 (seqno/RPC flake; A+C already PASS).
 */
process.env.TON_NETWORK = "testnet";
process.env.TON_DEPLOY_MODE = "live";
process.env.RUN_TESTNET_VALUETON_SWEEP = "true";
process.env.TEST_VALUETON_OVERRIDE = "true";
process.env.TEST_VALUETON_SWEEP_VALUES = "0.025";
process.env.TEST_VALUETON_SCENARIOS = "B";
process.env.TEST_VALUETON_STAKE_TON = "0.05";

console.log("R17.8V.2D.1 retry 0.025 B only");

const { main } = await import("../tests/testnet/runValueTonSweep.js");

await main([]);
