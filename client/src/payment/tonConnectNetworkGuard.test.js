import assert from "node:assert/strict";
import test from "node:test";

import {
    expectedTonConnectChain,
    isTonConnectChainCompatible,
    normalizePaymentNetwork
} from "./tonConnectNetworkGuard.js";

test("R18-S17 C3: normalize supported payment networks", () => {
    assert.equal(normalizePaymentNetwork("MAINNET"), "mainnet");
    assert.equal(normalizePaymentNetwork(" testnet "), "testnet");
    assert.equal(normalizePaymentNetwork("unknown"), null);
});

test("R18-S17 C3: map TON wallet chains to payment networks", () => {
    assert.equal(expectedTonConnectChain("mainnet"), "-239");
    assert.equal(expectedTonConnectChain("testnet"), "-3");
    assert.equal(expectedTonConnectChain(null), null);
});

test("R18-S17 C3: reject wrong wallet chain before send", () => {
    assert.equal(isTonConnectChainCompatible("mainnet", "-239"), true);
    assert.equal(isTonConnectChainCompatible("mainnet", "-3"), false);
    assert.equal(isTonConnectChainCompatible("testnet", "-3"), true);
    assert.equal(isTonConnectChainCompatible("testnet", "-239"), false);
    assert.equal(isTonConnectChainCompatible("mainnet", null), false);
    assert.equal(isTonConnectChainCompatible(null, "-239"), true);
});
