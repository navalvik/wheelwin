import assert from "node:assert/strict";
import { test } from "node:test";
import { buildNativeGramPaymentTransaction } from "./nativeGramTransfer.js";
const sender = "0:" + "1".repeat(64);
const destination = "0:" + "2".repeat(64);
const payment = {
    enabled: true, network: "testnet", asset: "TON",
    destination, expectedSender: sender,
    amountAtomic: "1500000000", reference: "payment-ABC_123",
    expiresAt: 1793000000000
};

test("native GRAM creates ONE direct room-wallet message with payer-borne gas and WW1 comment", () => {
    const tx = buildNativeGramPaymentTransaction(payment, sender, 1793000000);
    assert.equal(tx.validUntil, 1793000000);
    assert.equal(tx.messages.length, 1);
    assert.deepEqual(Object.keys(tx.messages[0]), ["address", "amount", "payload"]);
    assert.equal(tx.messages[0].address, destination);
    assert.equal(tx.messages[0].amount, "1500000000");
    const bytes = Buffer.from(tx.messages[0].payload, "base64");
    assert.equal(bytes.subarray(0, 4).toString("hex"), "b5ee9c72");
    assert.deepEqual([...bytes.subarray(13, 17)], [0, 0, 0, 0]);
    assert.equal(bytes.subarray(17).toString("utf8"), "WW1:payment-ABC_123");
    assert.equal(tx.messages[0].stateInit, undefined);
    assert.equal(tx.messages[0].jettonMaster, undefined);
});

test("native payment builder refuses disabled, Mainnet, Jetton and mismatched wallet", () => {
    for (const changed of [
        { enabled: false }, { network: "mainnet" }, { asset: "GRAM" },
        { jettonMaster: destination }, { senderJettonWalletAddress: destination },
        { reference: "bad comment!" }, { amountAtomic: "1.5" },
        { destination: sender }
    ]) {
        assert.throws(() => buildNativeGramPaymentTransaction(
            { ...payment, ...changed }, sender, 1793000000
        ), /not authorized/);
    }
    assert.throws(() => buildNativeGramPaymentTransaction(payment, destination, 1793000000), /not authorized/);
});

test("native payment expiry is never synthesized from local clocks", () => {
    for (const value of [undefined, null, 0, 1.5, "1793000000"]) {
        assert.throws(() => buildNativeGramPaymentTransaction(payment, sender, value),
            /expiry must be authoritative/);
    }
});

test("native GRAM payment rejects tampered, missing, or expired room deadline", () => {
    assert.throws(() => buildNativeGramPaymentTransaction(
        payment, sender, 1793003600
    ), /expiry must match/);
    assert.throws(() => buildNativeGramPaymentTransaction(
        { ...payment, expiresAt: null }, sender, 1793000000
    ), /expiry must match/);
    assert.throws(() => buildNativeGramPaymentTransaction(
        { ...payment, expiresAt: 1000 }, sender, 1
    ), /expiry must match/);
});
