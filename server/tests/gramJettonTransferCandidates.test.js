import assert from "node:assert/strict";
import { test } from "node:test";
import { mapGramJettonCandidates } from "../payment/toncenter/GramJettonTransferCandidates.js";

const master = "0:" + "a".repeat(64);
const sender = "0:" + "b".repeat(64);
const roomWallet = "0:" + "c".repeat(64);
const amount = "1500000000";
const filter = { jettonMaster: master, roomWallet, expectedSender: sender, expectedAmountAtomic: amount };
const record = {
    jetton_master: master,
    source: sender,
    destination: roomWallet,
    amount,
    transaction_aborted: false,
    transaction_hash: "1".repeat(64),
    transaction_lt: "12",
    transaction_now: 1700000001
};
function discovery(transfers, truncated = false) {
    return { transfers, truncated, finalized: false, verifiedForSettlement: false };
}

test("exactly matching GRAM event is a candidate, NOT final payment evidence", () => {
    const mapped = mapGramJettonCandidates(discovery([record]), filter);
    assert.equal(mapped.candidates.length, 1);
    assert.equal(mapped.candidates[0].amountAtomic, amount);
    assert.equal(mapped.candidates[0].finalized, false);
    assert.equal(mapped.candidates[0].verifiedForSettlement, false);
    assert.equal(mapped.candidates[0].paymentReference, null);
    assert.equal(mapped.complete, true);
});

test("wrong master, sender, recipient, amount and aborted transfers cannot become candidates", () => {
    for (const mutation of [
        { jetton_master: roomWallet },
        { source: roomWallet },
        { destination: sender },
        { amount: "1" },
        { amount: "1.5" },
        { transaction_aborted: true },
        { transaction_hash: "bad" },
        { transaction_lt: "0" },
        { transaction_now: 0 }
    ]) {
        assert.equal(mapGramJettonCandidates(discovery([{ ...record, ...mutation }]), filter).candidates.length, 0);
    }
});

test("repeated transaction identity is emitted once and full-page results are incomplete", () => {
    const mapped = mapGramJettonCandidates(discovery([record, record], true), filter);
    assert.equal(mapped.candidates.length, 1);
    assert.equal(mapped.complete, false);
});

test("reject unsupported evidence envelopes and invalid authoritative filter", () => {
    assert.throws(() => mapGramJettonCandidates({
        transfers: [record], finalized: true, verifiedForSettlement: true
    }, filter), /unverified/);
    assert.throws(() => mapGramJettonCandidates(discovery([record]), {
        ...filter, jettonMaster: "GRAM"
    }), /Invalid authoritative/);
});
