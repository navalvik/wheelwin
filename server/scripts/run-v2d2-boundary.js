/**
 * R17.8V.2D.2 — one-shot launcher (runtime env only).
 * Usage: node server/scripts/run-v2d2-boundary.js <valueTon> <scenarios>
 * Example: node server/scripts/run-v2d2-boundary.js 0.025 B
 */
const valueTon = String(process.argv[2] || "").trim();
const scenarios = String(process.argv[3] || "").trim().toUpperCase();

if (!valueTon || !scenarios) {
    console.error("Usage: node run-v2d2-boundary.js <valueTon> <scenarios>");
    process.exit(1);
}

process.env.TON_NETWORK = "testnet";
process.env.TON_DEPLOY_MODE = "live";
process.env.RUN_TESTNET_VALUETON_SWEEP = "true";
process.env.TEST_VALUETON_OVERRIDE = "true";
process.env.TEST_VALUETON_SWEEP_VALUES = valueTon;
process.env.TEST_VALUETON_SCENARIOS = scenarios;
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
    `R17.8V.2D.2 preflight OK | network=testnet | value=${valueTon} | scenarios=${scenarios}`
);

const { main } = await import("../tests/testnet/runValueTonSweep.js");
await main([]);
