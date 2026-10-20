import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    InProcessWalletOperationQueue,
    OUTGOING_WALLET_OPERATION_STATE as STATE,
    OutgoingWalletOperationStore,
    OutgoingWalletOperationStoreError
} from "../payment/fees/OutgoingWalletOperationStore.js";

const WALLET_A = "0:" + "1".repeat(64);
const WALLET_B = "0:" + "2".repeat(64);
const BASE = {
    idempotencyKey: "room-7:payout:player-1",
    roomId: "room-7",
    sourceWalletAddress: WALLET_A,
    destination: WALLET_B,
    amountAtomic: 500000000,
    purpose: "WINNER_PAYOUT",
    networkName: "TESTNET",
    globalId: -3
};
function fixture() {
    const dir = mkdtempSync(join(tmpdir(), "wheelwin-outgoing-journal-"));
    let now = 1000;
    const store = new OutgoingWalletOperationStore({
        filePath: join(dir, "outgoing-operations.json"),
        nowProvider: () => now++,
        idFactory: () => "op-1"
    });
    store.initialize();
    return { dir, store, close() { rmSync(dir, { recursive: true, force: true }); } };
}

test("creates an operation idempotently and persists no signing material", () => {
    const f = fixture();
    try {
        const first = f.store.create(BASE);
        const repeated = f.store.create({ ...BASE, operationId: "ignored-other-id" });
        assert.equal(first.created, true);
        assert.equal(repeated.created, false);
        assert.equal(first.operation.operationId, repeated.operation.operationId);
        assert.equal(f.store.list().length, 1);
        const disk = readFileSync(join(f.dir, "outgoing-operations.json"), "utf8");
        assert.equal(disk.includes("mnemonic"), false);
        assert.equal(disk.includes("privateKey"), false);
        assert.equal(disk.includes("signedBoc"), false);
    } finally { f.close(); }
});

test("rejects idempotency-key reuse with different operation parameters", () => {
    const f = fixture();
    try {
        f.store.create(BASE);
        assert.throws(() => f.store.create({ ...BASE, amountAtomic: BASE.amountAtomic + 1 }), OutgoingWalletOperationStoreError);
    } finally { f.close(); }
});

test("persists expected seqno before submission and holds ambiguous outcomes", () => {
    const f = fixture();
    try {
        const created = f.store.create(BASE).operation;
        const reserved = f.store.transition({
            operationId: created.operationId, expectedRevision: 0,
            nextState: STATE.SEQNO_RESERVED, expectedSeqno: 17
        });
        assert.equal(reserved.expectedSeqno, 17);
        const unknown = f.store.transition({
            operationId: reserved.operationId, expectedRevision: 1,
            nextState: STATE.SUBMISSION_UNKNOWN
        });
        assert.equal(unknown.state, STATE.SUBMISSION_UNKNOWN);
        assert.equal(unknown.expectedSeqno, 17);
        assert.throws(() => f.store.transition({
            operationId: unknown.operationId, expectedRevision: 2,
            nextState: STATE.PREPARED
        }), OutgoingWalletOperationStoreError);
    } finally { f.close(); }
});

test("finalization requires explicit transaction, block, actual fee and time", () => {
    const f = fixture();
    try {
        const created = f.store.create(BASE).operation;
        const reserved = f.store.transition({
            operationId: created.operationId, expectedRevision: 0,
            nextState: STATE.SEQNO_RESERVED, expectedSeqno: 3
        });
        const submitted = f.store.transition({
            operationId: reserved.operationId, expectedRevision: 1,
            nextState: STATE.SUBMITTED, transactionId: "tx-hash"
        });
        assert.throws(() => f.store.transition({
            operationId: submitted.operationId, expectedRevision: 2,
            nextState: STATE.FINALIZED
        }), OutgoingWalletOperationStoreError);
        const finalized = f.store.transition({
            operationId: submitted.operationId, expectedRevision: 2,
            nextState: STATE.FINALIZED, transactionId: "tx-hash",
            blockId: "0:shard:seqno", actualFeeAtomic: 1200, finalizedAtMs: 5000
        });
        assert.equal(finalized.state, STATE.FINALIZED);
        assert.equal(finalized.actualFeeAtomic, 1200);
    } finally { f.close(); }
});

test("revision checks reject stale writers and recovery reloads durable operations", () => {
    const f = fixture();
    try {
        const created = f.store.create(BASE).operation;
        assert.throws(() => f.store.transition({
            operationId: created.operationId, expectedRevision: 99,
            nextState: STATE.SEQNO_RESERVED, expectedSeqno: 1
        }), OutgoingWalletOperationStoreError);
        const restarted = new OutgoingWalletOperationStore({
            filePath: join(f.dir, "outgoing-operations.json"),
            nowProvider: () => 2000
        });
        restarted.initialize();
        assert.equal(restarted.get(created.operationId).state, STATE.PREPARED);
        assert.equal(restarted.listByWallet(WALLET_A).length, 1);
    } finally { f.close(); }
});

test("per-process wallet queue serializes tasks by canonical wallet identity", async () => {
    const queue = new InProcessWalletOperationQueue();
    const order = [];
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const first = queue.run(WALLET_A, async () => { order.push("a-start"); await gate; order.push("a-end"); });
    const second = queue.run(WALLET_A, async () => { order.push("b-start"); });
    const otherWallet = queue.run(WALLET_B, async () => { order.push("other-wallet"); });
    await otherWallet;
    assert.deepEqual(order, ["a-start", "other-wallet"]);
    release();
    await Promise.all([first, second]);
    assert.deepEqual(order, ["a-start", "other-wallet", "a-end", "b-start"]);
});
