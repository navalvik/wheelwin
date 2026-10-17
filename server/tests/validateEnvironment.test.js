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

// --- R7.0C regression: previously schema-less calls (missing schema argument) ---

// Each of these variables was passed as the schema argument (raw env value),
// so assertPresent read `schema.required` on undefined and threw TypeError.
// They now have schema entries and are all optional (required: false).

const newlySchemaVars = [
    { name: "TON_NETWORK", type: "string", valid: "testnet", invalid: true },
    { name: "TON_POLL_INTERVAL_MS", type: "integer", valid: "2000", min: 50, invalid: "not-an-integer" },
    { name: "TON_MAINNET_DRY_RUN_DEBUG", type: "boolean", valid: "true", invalid: "notabool" },
    { name: "TON_MAINNET_WALLET_IDENTITY_DEBUG", type: "boolean", valid: "true", invalid: "notabool" },
    { name: "PAYMENT_SESSION_DURATION_MS", type: "integer", valid: "5000", min: 1, invalid: "not-an-integer" },
    { name: "WALLET_CONNECTION_DURATION_MS", type: "integer", valid: "5000", min: 1, invalid: "not-an-integer" },
    { name: "GAME_CONTRACT_DEPLOY_TIMEOUT_MS", type: "integer", valid: "120000", min: 1, invalid: "not-an-integer" },
    { name: "ROOM_WALLET_PAYMENT_INTAKE_MODE", type: "string", valid: "ROOM_WALLET", invalid: true },
    { name: "ROOM_WALLET_RESIDUAL_SWEEP_ENABLED", type: "boolean", valid: "false", invalid: "notabool" },
    { name: "TON_RESIDUES_EXPECTED_ADDRESS", type: "string", valid: "EQdummy", invalid: true },
    { name: "TON_RESIDUES_MNEMONIC", type: "string", valid: "dummy dummy dummy dummy dummy dummy dummy dummy dummy dummy dummy dummy", invalid: true },
    { name: "ROOM_WALLETS_JSON", type: "string", valid: "[]", invalid: true },
    { name: "ROOM_WALLETS_TESTNET_JSON", type: "string", valid: "[]", invalid: true },
    { name: "ROOM_WALLETS_MAINNET_JSON", type: "string", valid: "[]", invalid: true }
];

const minimalEnv = {
    PORT: "3001",
    HOST: "0.0.0.0",
    CLIENT_ORIGIN: "http://localhost:5173",
    ROOM_MAX_PLAYERS: "3"
};

function collectRaw(extraEnv) {

    const collector = new ConfigurationIssueCollector();

    validateEnvironment(collector, {
        ...minimalEnv,
        ...extraEnv
    });

    return collector;
}

function issuesFor(collector, key) {

    return collector._issues.filter((issue) => issue.key === key);
}

// --- minimal valid production environment: completes without TypeError ---

{
    const collector = collectRaw();

    assert.equal(collector.size, 0, "minimal valid environment completes validation with no issues");

    console.log("  minimal valid environment: OK");
}

// --- absent optional values: no crash, no issue ---

for (const v of newlySchemaVars) {

    (() => {

        const collector = collectRaw();

        const issues = issuesFor(collector, v.name);

        assert.equal(
            issues.length,
            0,
            `${v.name} absent must not add an issue (no TypeError)`
        );

        console.log(`  absent ${v.name}: OK`);
    })();
}

// --- valid supplied values: no issue ---

for (const v of newlySchemaVars) {

    (() => {

        const collector = collectRaw({ [v.name]: v.valid });

        const issues = issuesFor(collector, v.name);

        assert.equal(
            issues.length,
            0,
            `${v.name}=${v.valid} must not add an issue`
        );

        console.log(`  valid ${v.name}=${v.valid}: OK`);
    })();
}

// --- invalid types: issue collected ---

for (const v of newlySchemaVars) {

    (() => {

        const collector = collectRaw({ [v.name]: v.invalid });

        const issues = issuesFor(collector, v.name);

        assert.equal(
            issues.length,
            1,
            `${v.name}=${String(v.invalid)} invalid type must add an issue`
        );

        const reasonMap = { string: "Invalid string", integer: "Invalid integer", boolean: "Invalid boolean" };

        assert.equal(
            issues[0].reason,
            reasonMap[v.type],
            `${v.name} invalid type must report expected type`
        );

        console.log(`  invalid-type ${v.name}=${String(v.invalid)}: OK`);
    })();
}

// --- integer numeric boundaries ---

{
    const belowMin = [
        { name: "TON_POLL_INTERVAL_MS", value: "10", min: 50 },
        { name: "PAYMENT_SESSION_DURATION_MS", value: "0", min: 1 },
        { name: "WALLET_CONNECTION_DURATION_MS", value: "0", min: 1 },
        { name: "GAME_CONTRACT_DEPLOY_TIMEOUT_MS", value: "0", min: 1 }
    ];

    for (const b of belowMin) {

        (() => {

            const collector = collectRaw({ [b.name]: b.value });

            const issues = issuesFor(collector, b.name);

            assert.equal(
                issues.length,
                1,
                `${b.name}=${b.value} below min ${b.min} must add an issue`
            );
            assert.equal(
                issues[0].reason,
                `Value below minimum (${b.min})`,
                `${b.name} below min must report boundary`
            );

            console.log(`  below-min ${b.name}=${b.value}: OK`);
        })();
    }

    const atMin = [
        { name: "TON_POLL_INTERVAL_MS", value: "50" },
        { name: "PAYMENT_SESSION_DURATION_MS", value: "1" },
        { name: "WALLET_CONNECTION_DURATION_MS", value: "1" },
        { name: "GAME_CONTRACT_DEPLOY_TIMEOUT_MS", value: "1" }
    ];

    for (const b of atMin) {

        (() => {

            const collector = collectRaw({ [b.name]: b.value });

            const issues = issuesFor(collector, b.name);

            assert.equal(
                issues.length,
                0,
                `${b.name}=${b.value} at min must not add an issue`
            );

            console.log(`  at-min ${b.name}=${b.value}: OK`);
        })();
    }
}

console.log("validateEnvironment.test.js: all assertions passed");
