/**
 * R17.8V.1C / R17.8V.2K — Unit tests for oracle valueTon resolver.
 * Confirms production default is 0.022 when override is disabled.
 */
import assert from "node:assert/strict";

import {
    PRODUCTION_ORACLE_VALUE_TON,
    isTestValueTonOverrideEnabled,
    resolveOracleValueTon
} from "../payment/ton/testValueTonOverride.js";

assert.equal(PRODUCTION_ORACLE_VALUE_TON, "0.022");

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
    "0.022"
);

assert.equal(
    resolveOracleValueTon("INIT_GAME", { TEST_VALUETON_OVERRIDE: "false" }),
    "0.022"
);

assert.equal(
    resolveOracleValueTon("OPEN_PAYMENTS", {}),
    "0.022"
);

assert.equal(
    resolveOracleValueTon("CANCEL", {}),
    "0.022"
);

assert.equal(
    resolveOracleValueTon("SETTLE", {}),
    "0.022"
);

assert.equal(
    resolveOracleValueTon("ARCHIVE", {}),
    "0.022"
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

// R17.8V.2K — temporary override still independent of production default.
assert.equal(
    resolveOracleValueTon("SETTLE", {
        TEST_VALUETON_OVERRIDE: "true",
        TEST_VALUETON_SETTLE: "0.04"
    }),
    "0.04"
);

assert.equal(
    resolveOracleValueTon("SETTLE", {
        TEST_VALUETON_OVERRIDE: "true"
        // missing TEST_VALUETON_SETTLE → fall back to production
    }),
    "0.022"
);

assert.equal(
    resolveOracleValueTon("DEPLOY", {
        TEST_VALUETON_OVERRIDE: "true",
        TEST_VALUETON_DEPLOY: "0"
    }),
    "0.022"
);

assert.equal(
    resolveOracleValueTon("DEPLOY", {
        TEST_VALUETON_OVERRIDE: "true",
        TEST_VALUETON_DEPLOY: "nope"
    }),
    "0.022"
);

console.log("testValueTonOverride.test.js: OK");
