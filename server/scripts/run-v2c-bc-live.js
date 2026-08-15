/**
 * R17.8V.2C — re-run Scenario B+C only at baseline 0.05 after wallet init fix.
 * Does not modify server/.env permanently.
 */
process.env.TON_NETWORK = "testnet";
process.env.TON_DEPLOY_MODE = "live";
process.env.RUN_TESTNET_VALUETON_SWEEP = "true";
process.env.TEST_VALUETON_OVERRIDE = "true";
process.env.TEST_VALUETON_SWEEP_VALUES = "0.05";
process.env.TEST_VALUETON_SCENARIOS = "B,C";
process.env.TEST_VALUETON_DEPLOY = "0.05";
process.env.TEST_VALUETON_INIT = "0.05";
process.env.TEST_VALUETON_OPEN = "0.05";
process.env.TEST_VALUETON_CANCEL = "0.05";
process.env.TEST_VALUETON_SETTLE = "0.05";
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
    "R17.8V.2C preflight OK | network=testnet | override=true | values=0.05 | scenarios=B,C"
);

const { main } = await import("../tests/testnet/runValueTonSweep.js");

await main([]);
