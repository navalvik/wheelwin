import test from "node:test";
import assert from "node:assert/strict";
import { mapOutgoingTransferCandidate } from "../payment/fees/ToncenterOutgoingTransferCandidateMapper.js";
import { ToncenterResponseError } from "../payment/toncenter/ToncenterErrors.js";

const source = `0:${"1".repeat(64)}`;
const destination = `0:${"2".repeat(64)}`;
const expected = {
    sourceWalletAddress: source,
    destination,
    amountAtomic: 500_000_000,
    transactionId: "tx-abc"
};
const row = {
    hash: "tx-abc",
    account: source,
    now: 1_800_000_000,
    lt: "987654321",
    total_fees: "12345",
    block_ref: { workchain: 0, shard: "8000000000000000", seqno: 123 },
    out_msgs: [{ destination, value: "500000000" }],
    description: { aborted: false, compute_ph: { success: true }, action: { success: true } }
};

test("maps exact outgoing transfer to a non-authorizing candidate", () => {
    const result = mapOutgoingTransferCandidate(row, expected);
    assert.equal(result.candidate, true);
    assert.equal(result.authorization, "NOT_AUTHORIZED");
    assert.equal(result.transactionId, "tx-abc");
    assert.equal(result.sourceWalletAddress, source);
    assert.equal(result.destination, destination);
    assert.equal(result.amountAtomic, 500_000_000);
    assert.equal(result.totalFeesAtomic, 12345);
    assert.equal(result.blockId, "0:8000000000000000:123");
    assert.equal(result.walletSeqno, null);
    assert.equal(result.finalized, false);
    assert.equal(result.walletSeqnoEvidenceRequired, true);
    assert.equal(result.finalityEvidenceRequired, true);
});

test("rejects a transaction hash that differs from the prepared operation", () => {
    assert.equal(mapOutgoingTransferCandidate({ ...row, hash: "other-tx" }, expected), null);
});

test("rejects wrong source, destination, or amount", () => {
    assert.equal(mapOutgoingTransferCandidate({ ...row, account: destination }, expected), null);
    assert.equal(mapOutgoingTransferCandidate({ ...row, out_msgs: [{ destination: source, value: "500000000" }] }, expected), null);
    assert.equal(mapOutgoingTransferCandidate({ ...row, out_msgs: [{ destination, value: "500000001" }] }, expected), null);
});

test("rejects aborted or failed transactions", () => {
    assert.equal(mapOutgoingTransferCandidate({ ...row, description: { aborted: true } }, expected), null);
    assert.equal(mapOutgoingTransferCandidate({ ...row, description: { compute_ph: { success: false } } }, expected), null);
});

test("rejects ambiguous duplicate matching messages", () => {
    assert.equal(mapOutgoingTransferCandidate({ ...row, out_msgs: [...row.out_msgs, ...row.out_msgs] }, expected), null);
});

test("malformed fee or block evidence fails closed", () => {
    assert.throws(() => mapOutgoingTransferCandidate({ ...row, total_fees: "unknown" }, expected), ToncenterResponseError);
    assert.throws(() => mapOutgoingTransferCandidate({ ...row, block_ref: null }, expected), ToncenterResponseError);
});

test("does not mistake transaction logical time or block sequence for wallet seqno", () => {
    const result = mapOutgoingTransferCandidate(row, expected);
    assert.equal(result.transactionLogicalTime, "987654321");
    assert.equal(result.walletSeqno, null);
});
