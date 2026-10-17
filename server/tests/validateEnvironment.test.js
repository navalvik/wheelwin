/**
 * R7.0C — Regression test for PAYMENT_COLLECTION_INTERVAL_MS validation.
 *
 * Covers the startup crash where validateIntegerField was invoked without the
 * schema argument (validateEnvironment.js), causing assertPresent to read
 * `schema.required` on undefined when the variable is absent.
 */
import assert from "node:assert/strict";

import { ENVIRONMENT_SCHEMA } from "../config/schemas/environmentSchema.js";
import { ConfigurationIssueCollector } from "../config/ConfigurationError.js";
import { validateEnvironment } from "../config/validators/validateEnvironment.js";

assert.equal(typeof validateEnvironment, "function");

// The schema entry must exist: it was missing, which left the validator call
// passing the raw env value as the schema.
const schema = ENVIRONMENT_SCHEMA.PAYMENT_COLLECTION_INTERVAL_MS;

assert.ok(schema, "ENVIRONMENT_SCHEMA.PAYMENT_COLLECTION_INTERVAL_MS must be defined");
assert.equal(schema.key, "PAYMENT_COLLECTION_INTERVAL_MS");
assert.equal(schema.type, "integer");
assert.equal(schema.required, false);
assert.equal(schema.min, 50);
assert.equal(schema.category, "Metrics");

// Required fields for a clean collector (all other required vars present),
// plus vars referenced by other validate*Field calls that omit the schema
// argument (separate latent bugs, out of scope for this fix). Setting them
// here keeps those calls from crashing on undefined so this test isolates
// PAYMENT_COLLECTION_INTERVAL_MS only.
const requiredFields = {
    PORT: "3001",
    HOST: "0.0.0.0",
    CLIENT_ORIGIN: "http://localhost:5173",
    ROOM_MAX_PLAYERS: "3",
    TON_NETWORK: "testnet",
    TON_POLL_INTERVAL_MS: "2000",
    PAYMENT_SESSION_DURATION_MS: "5000",
    WALLET_CONNECTION_DURATION_MS: "5000",
    GAME_CONTRACT_DEPLOY_TIMEOUT_MS: "60000",
    ROOM_WALLET_PAYMENT_INTAKE_MODE: "ROOM_WALLET",
    TON_RESIDUES_EXPECTED_ADDRESS: "EQdummy",
    TON_RESIDUES_MNEMONIC: "dummy dummy dummy dummy dummy dummy dummy dummy dummy dummy dummy dummy",
    ROOM_WALLETS_JSON: "[]",
    ROOM_WALLETS_TESTNET_JSON: "[]",
    ROOM_WALLETS_MAINNET_JSON: "[]"
};

function collect(extraEnv) {

    const collector = new ConfigurationIssueCollector();

    validateEnvironment(collector, {
        ...requiredFields,
        ...extraEnv
    });

    return collector;
}

function paymentIssues(collector) {

    return collector._issues.filter(
        (issue) => issue.key === "PAYMENT_COLLECTION_INTERVAL_MS"
    );
}

// --- absent: no crash, no issue (required: false) ---

{
    const collector = collect();

    assert.equal(
        paymentIssues(collector).length,
        0,
        "absent PAYMENT_COLLECTION_INTERVAL_MS must not add an issue"
    );
    assert.equal(collector.size, 0, "no validation issues when the field is absent");

    console.log("  absent PAYMENT_COLLECTION_INTERVAL_MS: OK");
}

// --- present valid value (>= min): no issue ---

{
    const collector = collect({ PAYMENT_COLLECTION_INTERVAL_MS: "5000" });

    assert.equal(
        paymentIssues(collector).length,
        0,
        "valid PAYMENT_COLLECTION_INTERVAL_MS must not add an issue"
    );

    console.log("  valid PAYMENT_COLLECTION_INTERVAL_MS=5000: OK");
}

// --- present at min boundary: no issue ---

{
    const collector = collect({ PAYMENT_COLLECTION_INTERVAL_MS: "50" });

    assert.equal(
        paymentIssues(collector).length,
        0,
        "boundary PAYMENT_COLLECTION_INTERVAL_MS=50 must not add an issue"
    );

    console.log("  boundary PAYMENT_COLLECTION_INTERVAL_MS=50: OK");
}

// --- present below min: issue collected ---

{
    const collector = collect({ PAYMENT_COLLECTION_INTERVAL_MS: "10" });

    const issues = paymentIssues(collector);

    assert.equal(issues.length, 1, "below-min PAYMENT_COLLECTION_INTERVAL_MS must add an issue");
    assert.equal(issues[0].reason, "Value below minimum (50)");
    assert.equal(issues[0].expectedType, "integer");

    console.log("  below-min PAYMENT_COLLECTION_INTERVAL_MS=10: OK");
}

// --- present non-integer: issue collected ---

{
    const collector = collect({ PAYMENT_COLLECTION_INTERVAL_MS: "not-an-integer" });

    const issues = paymentIssues(collector);

    assert.equal(issues.length, 1, "non-integer PAYMENT_COLLECTION_INTERVAL_MS must add an issue");
    assert.equal(issues[0].reason, "Invalid integer");

    console.log("  non-integer PAYMENT_COLLECTION_INTERVAL_MS: OK");
}

console.log("validateEnvironment.test.js: all assertions passed");
