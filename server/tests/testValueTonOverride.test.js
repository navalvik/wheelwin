/**
 * R17.8V.1C — Unit tests for test-only valueTon override.
 * Confirms production default remains 0.05 when override is disabled.
 */
import assert from "node:assert/strict";

import {
    PRODUCTION_ORACLE_VALUE_TON,
    isTestValueTonOverrideEnabled,
    resolveOracleValueTon
} from "../payment/ton/testValueTonOverride.js";

assert.equal(PRODUCTION_ORACLE_VALUE_TON, "0.05");

assert.equal(
    isTestValueTonOverrideEnabled({}),
    false
);

assert.equal(
    isTestValueTonOverrideEnabled({ TEST_VALUETON_OVERRIDE: "true" }),
    true
);

assert.equal(
    resolveOracleValueTon("DEPLOY", {}),
    "0.05"
);

assert.equal(
    resolveOracleValueTon("INIT_GAME", { TEST_VALUETON_OVERRIDE: "false" }),
    "0.05"
);

assert.equal(
    resolveOracleValueTon("DEPLOY", {
        TEST_VALUETON_OVERRIDE: "true",
        TEST_VALUETON_DEPLOY: "0.02"
    }),
    "0.02"
);

assert.equal(
    resolveOracleValueTon("CANCEL", {
        TEST_VALUETON_OVERRIDE: "true",
        TEST_VALUETON_CANCEL: "0.015"
    }),
    "0.015"
);

assert.equal(
    resolveOracleValueTon("SETTLE", {
        TEST_VALUETON_OVERRIDE: "true"
        // missing TEST_VALUETON_SETTLE → fall back to production
    }),
    "0.05"
);

assert.equal(
    resolveOracleValueTon("DEPLOY", {
        TEST_VALUETON_OVERRIDE: "true",
        TEST_VALUETON_DEPLOY: "0"
    }),
    "0.05"
);

assert.equal(
    resolveOracleValueTon("DEPLOY", {
        TEST_VALUETON_OVERRIDE: "true",
        TEST_VALUETON_DEPLOY: "nope"
    }),
    "0.05"
);

console.log("testValueTonOverride.test.js: OK");
