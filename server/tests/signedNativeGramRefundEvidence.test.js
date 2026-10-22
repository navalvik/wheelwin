import assert from "node:assert/strict";
import { test } from "node:test";
import { makeNativeRefundV4Boc } from "./fixtures/nativeRefundV4BocFixture.js";
import {
    signedRefundBocHashOrNull, verifyInspectedNativeGramRefund
} from "../payment/refund/SignedNativeGramRefundEvidence.js";

const source = "0:" + "a".repeat(64);
const dest = "0:" + "b".repeat(64);
const signedTransfer = { boc: makeNativeRefundV4Boc({ to: "b".repeat(64) }).toString("base64") };
const expected = {
    networkName: "TESTNET", globalId: -3,
    idempotencyKey: "TESTNET:payment-ref:incoming-tx",
    from: source, to: dest, amountAtomic: "990000000"
};
const valid = {
    verified: true, evidenceSource: "decoded-signed-ton-boc",
    bocSha256: signedRefundBocHashOrNull(signedTransfer),
    networkName: "TESTNET", globalId: -3,
    idempotencyKey: expected.idempotencyKey,
    from: source,
    messages: [{
        to: dest, amountAtomic: "990000000", sendMode: 3,
        sendRemainingBalance: false, bounce: true
    }]
};

test("exact inspected signed bytes and one fee-funded refund message are required", () => {
    assert.equal(verifyInspectedNativeGramRefund({ signedTransfer, inspected: valid, expected }), true);
    assert.equal(verifyInspectedNativeGramRefund({
        signedTransfer: { boc: makeNativeRefundV4Boc({ to: "b".repeat(64), amount: 990000001n }).toString("base64") },
        inspected: valid, expected
    }), false);
});

test("real BOC payment fields defeat a forged inspector with matching hash", () => {
    for (const changedBoc of [
        makeNativeRefundV4Boc({ to: "b".repeat(64), amount: 1000000000n }),
        makeNativeRefundV4Boc({ to: "a".repeat(64) }),
        makeNativeRefundV4Boc({ to: "b".repeat(64), mode: 1 })
    ]) {
        const forgedTransfer = { boc: changedBoc.toString("base64") };
        const forged = {
            ...valid,
            bocSha256: signedRefundBocHashOrNull(forgedTransfer)
        };
        assert.equal(verifyInspectedNativeGramRefund({
            signedTransfer: forgedTransfer, inspected: forged, expected
        }), false, "decoded TON fields must override claimed inspector metadata");
    }
});

test("fail closed for boolean-only inspector, mismatched or unsigned transfer details", () => {
    for (const inspected of [
        { verified: true },
        { ...valid, verified: false },
        { ...valid, evidenceSource: "self-reported" },
        { ...valid, bocSha256: "0".repeat(64) },
        { ...valid, networkName: "MAINNET" },
        { ...valid, globalId: -239 },
        { ...valid, idempotencyKey: "other" },
        { ...valid, from: dest },
        { ...valid, messages: [] },
        { ...valid, messages: [valid.messages[0], valid.messages[0]] },
        { ...valid, messages: [{ ...valid.messages[0], to: source }] },
        { ...valid, messages: [{ ...valid.messages[0], amountAtomic: "1000000000" }] },
        { ...valid, messages: [{ ...valid.messages[0], sendMode: 128 }] },
        { ...valid, messages: [{ ...valid.messages[0], sendMode: 131 }] },
        { ...valid, messages: [{ ...valid.messages[0], sendRemainingBalance: true }] },
        { ...valid, messages: [{ ...valid.messages[0], bounce: false }] }
    ]) {
        assert.equal(verifyInspectedNativeGramRefund({ signedTransfer, inspected, expected }), false);
    }
    assert.equal(signedRefundBocHashOrNull({ boc: "not base64*" }), null);
    assert.equal(signedRefundBocHashOrNull({ boc: "AA==" }), null);
});
