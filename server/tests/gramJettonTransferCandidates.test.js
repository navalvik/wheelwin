import assert from "node:assert/strict";
import { test } from "node:test";
import { mapGramJettonCandidates } from "../payment/toncenter/GramJettonTransferCandidates.js";

const master = "0:" + "a".repeat(64);
const sender = "0:" + "b".repeat(64);
const roomWallet = "0:" + "c".repeat(64);
const amount = "1500000000";
const filter = { jettonMaster: master, roomWallet, expectedSender: sender, expectedAmountAtomic: amount, expectedPaymentReference: "room1-seat2" };
const record = {
    jetton_master: master,
    source: sender,
    source_wallet: "0:" + "d".repeat(64),
    destination: roomWallet,
    amount,
    transaction_aborted: false,
    transaction_hash: "1".repeat(64),
    transaction_lt: "12",
    transaction_now: 1700000001,
    decoded_forward_payload: { type: "text_comment", comment: "WW1:room1-seat2" }
};
function discovery(transfers, truncated = false) {
    return { transfers, truncated, finalized: false, verifiedForSettlement: false };
}

test("exactly matching GRAM event is a candidate, NOT final payment evidence", () => {
    const mapped = mapGramJettonCandidates(discovery([record]), filter);
    assert.equal(mapped.candidates.length, 1);
    assert.equal(mapped.candidates[0].amountAtomic, amount);
    assert.equal(mapped.candidates[0].sourceJettonWallet, "0:" + "d".repeat(64));
    assert.equal(mapped.candidates[0].finalized, false);
    assert.equal(mapped.candidates[0].verifiedForSettlement, false);
    assert.equal(mapped.candidates[0].paymentReference, null);
    assert.equal(mapped.complete, true);
});

test("wrong master, sender, recipient, amount and aborted transfers cannot become candidates", () => {
    for (const mutation of [
        { jetton_master: roomWallet },
        { source: roomWallet },
        { source_wallet: "not-a-wallet" },
        { source_wallet: undefined },
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

test("indexer records outside the authoritative payment window are rejected", () => {
    const bounded = {
        ...filter,
        startUtime: 1700000000,
        endUtime: 1700000400
    };
    assert.equal(mapGramJettonCandidates(discovery([record]), bounded).candidates.length, 1);
    assert.equal(mapGramJettonCandidates(discovery([
        { ...record, transaction_now: 1699999999 },
        { ...record, transaction_now: 1700000401 }
    ]), bounded).candidates.length, 0);
    assert.throws(() => mapGramJettonCandidates(discovery([record]), {
        ...bounded, startUtime: 1700000500
    }), /Invalid authoritative/);
});

test("strict decoded GRAM forward comment filters by authoritative reference only", () => {
    const intent = { ...filter, expectedPaymentReference: "room1-seat2" };
    const matching = {
        ...record,
        decoded_forward_payload: { type: "text_comment", comment: "WW1:room1-seat2" }
    };
    const found = mapGramJettonCandidates(discovery([matching]), intent);
    assert.equal(found.candidates.length, 1);
    assert.equal(found.candidates[0].referenceHintMatched, true);
    assert.equal(found.candidates[0].paymentReference, null);
    assert.equal(found.candidates[0].finalized, false);
    assert.equal(found.candidates[0].verifiedForSettlement, false);

    for (const value of [
        undefined,
        { type: "text_comment", comment: "WW1:other" },
        { type: "text_comment", comment: "room1-seat2" },
        { type: "binary", comment: "WW1:room1-seat2" },
        { comment: "WW1:room1-seat2" },
        "WW1:room1-seat2"
    ]) {
        assert.equal(mapGramJettonCandidates(discovery([
            { ...record, decoded_forward_payload: value }
        ]), intent).candidates.length, 0);
    }
});

test("invalid authoritative GRAM payment references cannot be queried", () => {
    assert.throws(() => mapGramJettonCandidates(discovery([record]), {
        ...filter, expectedPaymentReference: "room/seat"
    }), /Invalid authoritative/);
});

test("sender and exact amount alone cannot yield a GRAM candidate without payment reference", () => {
    assert.throws(() => mapGramJettonCandidates(discovery([record]), {
        ...filter, expectedPaymentReference: undefined
    }), /Invalid authoritative/);
});
