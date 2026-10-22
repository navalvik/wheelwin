import assert from "node:assert/strict";
import { test } from "node:test";
import { assessVerifiedGramIntentAdmission } from "../payment/incoming/VerifiedGramIntentAdmission.js";

const master = "0:" + "a".repeat(64);
const sender = "0:" + "b".repeat(64);
const recipient = "0:" + "c".repeat(64);
const paymentReference = "seat1_room1";
const intent = {
    paymentReference, network: "testnet", asset: "GRAM", state: "PENDING",
    amountAtomic: 1500000000, expectedSender: sender,
    destinationWalletAddress: recipient
};
const verifiedEvidence = {
    asset: "GRAM", kind: "VERIFIED_JETTON_TRANSFER",
    finalized: true, aborted: false,
    sender, recipient, tokenMaster: master,
    amountAtomic: "1500000000", paymentReference, transactionId: "chain:tx:1"
};
function store(stored = intent, prior = null) {
    return {
        require(ref) { assert.equal(ref, paymentReference); return stored; },
        findByTransactionId(id) { assert.equal(id, verifiedEvidence.transactionId); return prior; }
    };
}
function assess(changes = {}) {
    return assessVerifiedGramIntentAdmission({
        intentStore: store(), paymentReference, expectedTokenMaster: master,
        verifiedEvidence, ...changes
    });
}
test("matching independently verified GRAM evidence yields advisory preflight, NEVER credit", () => {
    assert.deepEqual(assess(), {
        paymentReference, transactionId: "chain:tx:1",
        amountAtomic: "1500000000", asset: "GRAM", network: "testnet",
        writeAuthorized: false, settlementAuthorized: false
    });
});
test("native TON, wrong token master, amount, payer, recipient or payment reference rejected", () => {
    for (const changed of [
        { asset: "TON" }, { tokenMaster: recipient }, { amountAtomic: "1" },
        { sender: recipient }, { recipient: sender }, { paymentReference: "other" },
        { finalized: false }, { aborted: true }
    ]) {
        assert.throws(() => assess({ verifiedEvidence: { ...verifiedEvidence, ...changed } }));
    }
});
test("wrong intent network, asset, state or denomination rejected", () => {
    for (const changed of [
        { network: "mainnet" }, { asset: "TON" }, { state: "SETTLED" },
        { state: "MATCHED" }, { amountAtomic: 1.2 }
    ]) {
        assert.throws(() => assess({ intentStore: store({ ...intent, ...changed }) }),
            /cannot be admitted/);
    }
});
test("a transaction already assigned to another intent cannot pass read-only admission", () => {
    assert.throws(() => assess({ intentStore: store(intent, {
        paymentReference: "other"
    }) }), /already been assigned/);
});
test("malformed authoritative master and payment reference fail closed", () => {
    assert.throws(() => assess({ expectedTokenMaster: "GRAM" }), /does not match/);
    assert.throws(() => assess({ paymentReference: "bad/reference" }), /Invalid authoritative/);
});
