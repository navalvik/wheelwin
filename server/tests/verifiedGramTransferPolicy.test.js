import assert from "node:assert/strict";
import { test } from "node:test";
import { requireVerifiedGramTransfer } from "../payment/incoming/VerifiedGramTransferPolicy.js";

const expected = {
    expectedTokenMaster: "testnet-master",
    expectedSender: "player-wallet",
    expectedRecipient: "room-wallet",
    expectedAmountAtomic: "1500000000",
    expectedPaymentReference: "payment-ref"
};
const valid = {
    asset: "GRAM",
    kind: "VERIFIED_JETTON_TRANSFER",
    finalized: true,
    aborted: false,
    tokenMaster: "testnet-master",
    sender: "player-wallet",
    recipient: "room-wallet",
    amountAtomic: "1500000000",
    paymentReference: "payment-ref",
    transactionId: "tx-1"
};

test("native TON transfer cannot confirm GRAM stake", () => {
    assert.throws(() => requireVerifiedGramTransfer({
        ...valid, asset: "TON", kind: "NATIVE_TON_TRANSFER"
    }, expected), /GRAM payment requires/);
});

test("GRAM token master, sender, recipient, amount and reference must all match", () => {
    for (const field of ["tokenMaster", "sender", "recipient", "amountAtomic", "paymentReference"]) {
        assert.throws(() => requireVerifiedGramTransfer({
            ...valid, [field]: "wrong"
        }, expected), /does not match/);
    }
});

test("unfinalized or aborted token event cannot confirm payment", () => {
    assert.throws(() => requireVerifiedGramTransfer({
        ...valid, finalized: false
    }, expected), /finalized/);
    assert.throws(() => requireVerifiedGramTransfer({
        ...valid, aborted: true
    }, expected), /finalized/);
});

test("matching finalized GRAM evidence returns only transaction identity and amount", () => {
    assert.deepEqual(requireVerifiedGramTransfer(valid, expected), {
        transactionId: "tx-1", asset: "GRAM", amountAtomic: "1500000000"
    });
});
