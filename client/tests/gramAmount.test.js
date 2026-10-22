import assert from "node:assert/strict";
import { test } from "node:test";
import { formatGramUnits, parseGramToNanoUnits } from "../src/payment/gramAmount.js";

test("GRAM UI shows whole units without trailing decimal zeroes", () => {
    assert.equal(formatGramUnits("1000000000"), "1");
    assert.equal(formatGramUnits("10000000000"), "10");
    assert.equal(formatGramUnits("1500000000"), "1.5");
    assert.equal(formatGramUnits("1250000000"), "1.25");
    assert.equal(formatGramUnits("100000000"), "0.1");
    assert.equal(formatGramUnits("10000000"), "0.01");
    assert.equal(formatGramUnits("0"), "0");
});

test("GRAM UI rounds to two decimal places using integer arithmetic", () => {
    assert.equal(formatGramUnits("1234567890"), "1.23");
    assert.equal(formatGramUnits("1235000000"), "1.24");
    assert.equal(formatGramUnits("999999999"), "1");
    assert.equal(formatGramUnits("999999999999999999999"), "1000000000000");
    assert.equal(formatGramUnits("-1250000000"), "-1.25");
});

test("GRAM decimal input converts to exact smallest units", () => {
    assert.equal(parseGramToNanoUnits("1"), "1000000000");
    assert.equal(parseGramToNanoUnits("1.5"), "1500000000");
    assert.equal(parseGramToNanoUnits("0.01"), "10000000");
    assert.equal(parseGramToNanoUnits("0.000000001"), "1");
    assert.throws(() => parseGramToNanoUnits("0.0000000001"));
    assert.throws(() => parseGramToNanoUnits("1e3"));
});
