import assert from "node:assert/strict";
import { test } from "node:test";
import { requireGramJettonMaster } from "../payment/incoming/GramJettonMasterConfig.js";

test("GRAM Jetton Master is mandatory, never inferred from token ticker", () => {
    assert.throws(() => requireGramJettonMaster({ env: {} }), /must be configured/);
    assert.throws(() => requireGramJettonMaster({
        env: { GRAM_JETTON_MASTER_TESTNET: "GRAM" }
    }), /valid TON address/);
});

test("accepts configured master in TON raw address form", () => {
    const master = `0:${"a".repeat(64)}`;
    assert.equal(requireGramJettonMaster({
        env: { GRAM_JETTON_MASTER_TESTNET: master }
    }), master);
});

test("Testnet master cannot silently authorize Mainnet", () => {
    assert.throws(() => requireGramJettonMaster({
        env: { GRAM_JETTON_MASTER_TESTNET: `0:${"a".repeat(64)}` },
        network: "mainnet"
    }), /Testnet-only/);
});

test("rejects malformed friendly master even when its length looks correct", () => {
    assert.throws(() => requireGramJettonMaster({
        env: { GRAM_JETTON_MASTER_TESTNET: "E".repeat(48) }
    }), /valid TON account address/);
});

test("rejects unsupported workchains and malformed raw master addresses", () => {
    assert.throws(() => requireGramJettonMaster({
        env: { GRAM_JETTON_MASTER_TESTNET: "0:" + "g".repeat(64) }
    }), /valid TON account address/);
});
