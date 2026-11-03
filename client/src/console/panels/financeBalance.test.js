import assert from "node:assert/strict";
import test from "node:test";
import { FINANCE_REFRESH_INTERVAL_MS, formatFinanceBalance } from "./financeBalance.js";

test("Finance Mainnet formats balances in TON and Testnet retains GRAM", () => {
    assert.equal(formatFinanceBalance("1234567890", "mainnet"), "1.234567890 TON");
    assert.equal(formatFinanceBalance("1234567890", "testnet"), "1.234567890 GRAM");
    assert.equal(formatFinanceBalance(null, "mainnet"), "—");
});

test("Finance balance polling remains every ten seconds", () => {
    assert.equal(FINANCE_REFRESH_INTERVAL_MS, 10_000);
});
