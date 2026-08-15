/**
 * R17.8V.2D.1 — Reduced ValueTon matrix sweep (runtime env only).
 * Does not permanently modify server/.env.
 * Values: 0.05, 0.04, 0.03, 0.025, 0.02 — scenarios A,B,C.
 */
process.env.TON_NETWORK = "testnet";
process.env.TON_DEPLOY_MODE = "live";
process.env.RUN_TESTNET_VALUETON_SWEEP = "true";
process.env.TEST_VALUETON_OVERRIDE = "true";
process.env.TEST_VALUETON_SWEEP_VALUES = "0.05,0.04,0.03,0.025,0.02";
process.env.TEST_VALUETON_SCENARIOS = "A,B,C";
process.env.TEST_VALUETON_STAKE_TON = "0.05";

if (process.env.TON_NETWORK !== "testnet") {

    console.error("STOP: TON_NETWORK must be testnet");
    process.exit(1);

}

if (process.env.TEST_VALUETON_OVERRIDE !== "true") {

    console.error("STOP: TEST_VALUETON_OVERRIDE must be true");
    process.exit(1);

}

if (process.env.RUN_TESTNET_VALUETON_SWEEP !== "true") {

    console.error("STOP: RUN_TESTNET_VALUETON_SWEEP must be true");
    process.exit(1);

}

console.log(
    "R17.8V.2D.1 preflight OK | network=testnet | override=true "
        + `| values=${process.env.TEST_VALUETON_SWEEP_VALUES} `
        + `| scenarios=${process.env.TEST_VALUETON_SCENARIOS}`
);

const { main } = await import("../tests/testnet/runValueTonSweep.js");

await main([]);
