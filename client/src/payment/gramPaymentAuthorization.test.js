import assert from "node:assert/strict";
import { test } from "node:test";
import {
    assessGramPaymentRequest,
    tonAccountIdentityOrNull
} from "./gramPaymentAuthorization.js";

const address = n => "0:" + n.repeat(64);
const sender = address("1");
const ready = {
    enabled: true,
    network: "testnet",
    asset: "TON",
    destination: address("4"),
    expectedSender: sender,
    amountAtomic: "1500000000",
    reference: "pay-1"
};

test("native GRAM room wallet payment with matching connected owner passes local preflight only", () => {
    assert.deepEqual(assessGramPaymentRequest(ready, sender), {
        ready: true, reason: "PRECHECK_ONLY", amountAtomic: "1500000000"
    });
});

test("Jetton GRAM, mainnet and disabled acceptance are all denied", () => {
    for (const changes of [
        { asset: "GRAM" },
        { network: "mainnet" },
        { enabled: false }
    ]) {
        assert.equal(assessGramPaymentRequest({ ...ready, ...changes }, sender).ready, false);
    }
});

test("unauthorized payer and stale Jetton protocol cannot pass native preflight", () => {
    assert.equal(assessGramPaymentRequest(ready, address("5")).ready, false);
    assert.equal(assessGramPaymentRequest(ready, null).ready, false);
    assert.equal(assessGramPaymentRequest({ ...ready, expectedSender: "" }, sender).ready, false);
    assert.equal(assessGramPaymentRequest({ ...ready, destination: sender }, sender).ready, false);
    assert.equal(assessGramPaymentRequest({ ...ready, jettonWalletVerified: true }, sender).ready, false);
    assert.equal(assessGramPaymentRequest({ ...ready, senderJettonWalletAddress: address("3") }, sender).ready, false);
    assert.equal(assessGramPaymentRequest({ ...ready, jettonMaster: address("2") }, sender).ready, false);
});

test("amount and comment must be strictly validated before preparing native transfer", () => {
    assert.equal(assessGramPaymentRequest({ ...ready, amountAtomic: "1.5" }, sender).ready, false);
    assert.equal(assessGramPaymentRequest({ ...ready, reference: "x".repeat(65) }, sender).ready, false);
    assert.equal(assessGramPaymentRequest({ ...ready, reference: "line\nbreak" }, sender).ready, false);
});

test("raw TON identity rejects malformed workchains and addresses", () => {
    assert.equal(tonAccountIdentityOrNull(address("A")), address("a"));
    assert.equal(tonAccountIdentityOrNull("256:" + "0".repeat(64)), null);
    assert.equal(tonAccountIdentityOrNull(" " + sender), null);
    assert.equal(tonAccountIdentityOrNull("0:" + "g".repeat(64)), null);
});
