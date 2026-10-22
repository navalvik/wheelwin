import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectGramJettonMessageLink } from "../payment/toncenter/GramJettonTraceMessageLink.js";

const sender = "0:" + "a".repeat(64);
const receiver = "0:" + "b".repeat(64);
const senderHash = "c".repeat(64);
const receiverHash = "d".repeat(64);
const messageHash = "e".repeat(64);
const traceId = "f".repeat(64);
const candidate = {
    traceId, sourceJettonWallet: sender, transactionHash: senderHash
};
function trace() {
    return {
        trace_id: traceId, is_incomplete: false,
        trace_info: { pending_messages: 0 },
        trace: {
            tx_hash: senderHash,
            transaction: {
                account: sender,
                out_msgs: [{ hash: messageHash, source: sender, destination: receiver }]
            },
            children: [{
                tx_hash: receiverHash,
                transaction: {
                    account: receiver,
                    in_msg: { hash: messageHash, source: sender, destination: receiver }
                }, children: []
            }]
        }
    };
}
function link(indexedTrace = trace(), expectedReceiver = receiver) {
    return inspectGramJettonMessageLink({
        indexedTrace, candidate, recipientJettonWallet: expectedReceiver
    });
}

test("direct indexed message-hash edge is a HINT, not finality or GRAM evidence", () => {
    const r = link();
    assert.equal(r.senderTransactionHash, senderHash);
    assert.equal(r.receiverTransactionHash, receiverHash);
    assert.equal(r.messageHash, messageHash);
    assert.equal(r.indexedMessageEdgeObserved, true);
    assert.equal(r.messageBodyVerified, false);
    assert.equal(r.recipientWalletMasterVerified, false);
    assert.equal(r.receiverFinalityVerified, false);
    assert.equal(r.paymentCreditAuthorized, false);
    assert.equal(r.kind, undefined);
});

test("same trace alone, wrong message hash, wrong owner and missing out_msg are rejected", () => {
    for (const change of [
        t => { t.trace.children[0].transaction.in_msg.hash = "1".repeat(64); },
        t => { t.trace.children[0].transaction.in_msg.source = receiver; },
        t => { t.trace.children[0].transaction.account = sender; },
        t => { t.trace.children[0].transaction.in_msg.destination = sender; },
        t => { t.trace.transaction.out_msgs = []; },
        t => { t.trace.tx_hash = "2".repeat(64); },
        t => { t.trace_id = "3".repeat(64); },
        t => { t.is_incomplete = true; },
        t => { t.trace_info.pending_messages = 1; }
    ]) {
        const copy = trace(); change(copy);
        assert.equal(link(copy), null);
    }
    assert.equal(link(trace(), sender), null);
});

test("replayed/ambiguous children and malformed trace tree reject", () => {
    const duplicated = trace();
    duplicated.trace.children.push(structuredClone(duplicated.trace.children[0]));
    assert.equal(link(duplicated), null);
    const cycle = trace();
    cycle.trace.children[0].children = [cycle.trace];
    assert.equal(link(cycle), null);
    const malformed = trace();
    malformed.trace.children = "not-an-array";
    assert.equal(link(malformed), null);
});
