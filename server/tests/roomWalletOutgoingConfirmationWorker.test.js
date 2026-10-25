import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TonFinancialPersistence } from "../persistence/TonFinancialPersistence.js";
import { RoomWalletOutboundIntentJournal } from "../payment/roomWallet/RoomWalletOutboundIntentJournal.js";
import { RoomWalletSingleWriterGate } from "../payment/roomWallet/RoomWalletSingleWriterGate.js";
import { RoomWalletOutboundChainFinalizer } from "../payment/roomWallet/RoomWalletOutboundChainFinalizer.js";
import { RoomWalletOutboundConfirmationWorker } from "../payment/roomWallet/RoomWalletOutboundConfirmationWorker.js";
import { fetchOutgoingConfirmationHistory } from "../payment/roomWallet/RoomWalletOutgoingChainScanner.js";

const ROOM = "0:c6423c1a3f43921316bd31f66287ad437b94d0b9421340f622619c9fa80173a6";
const OLGA = "0:bdab0280cbbda45f5a0fb6bc97fa0e72e380769986440761d574901e269ae56b";
const BOB = "0:2d8205bb979c1f41c3f2cb7f18ee656e5e7874c111dca4528f21db426dc4476f";
const SIGNED = "b".repeat(64);
const SOURCE_TX_HASH = "decf4284978c28153475f4ac94668f77e233bed93d6aaf32f3ed9e737514565c";
const OUT = "f".repeat(64);
const base64 = hash => Buffer.from(hash, "hex").toString("base64");
const tx = [
    { lt: "305", hash: SOURCE_TX_HASH, time: 300, externalHash: SIGNED, recipient: OLGA,
        amount: "998611722", outgoingHash: OUT },
    { lt: "304", hash: "a".repeat(64), time: 250, externalHash: "1".repeat(64),
        recipient: BOB, amount: "1000000", outgoingHash: "2".repeat(64) },
    { lt: "303", hash: "3".repeat(64), time: 190, externalHash: "4".repeat(64),
        recipient: BOB, amount: "1000000", outgoingHash: "5".repeat(64) }
];
function toProvider(row, provider) {
    const v3 = provider === "toncenter-v3";
    return {
        account: v3 ? ROOM.toUpperCase() : { address: ROOM },
        lt: row.lt,
        hash: v3 ? base64(row.hash) : row.hash,
        ...(v3 ? { now: row.time } : { utime: row.time, success: true }),
        in_msg: { hash: v3 ? base64(row.externalHash) : row.externalHash },
        out_msgs: [{
            destination: v3 ? row.recipient : { address: row.recipient },
            value: row.amount,
            hash: v3 ? base64(row.outgoingHash) : row.outgoingHash
        }]
    };
}
function makeFetch({ tonapi = tx, toncenter = tx, httpFailure = null, ignoreCursor = false } = {}) {
    const calls = [];
    const fetchImpl = async (url, args) => {
        assert.equal(args.method, "GET");
        const u = new URL(url);
        const provider = url.includes("tonapi.io") ? "tonapi" : "toncenter-v3";
        calls.push({ provider, url });
        if (provider === httpFailure) return { ok: false, status: 542 };
        const source = provider === "tonapi" ? tonapi : toncenter;
        const limit = Number(u.searchParams.get("limit"));
        const before = provider === "tonapi"
            ? u.searchParams.get("before_lt") : u.searchParams.get("end_lt");
        const page = source.filter(row =>
            !before || ignoreCursor
            || (provider === "tonapi"
                ? BigInt(row.lt) < BigInt(before)
                : BigInt(row.lt) <= BigInt(before))
        ).slice(0, limit);
        return { ok: true, status: 200, async json() {
            return { transactions: page.map(row => toProvider(row, provider)) };
        }};
    };
    return { fetchImpl, calls };
}
function query(fetchImpl, overrides = {}) {
    return fetchOutgoingConfirmationHistory({
        roomWallet: ROOM, cutoffUnixSeconds: 200,
        fetchImpl, limit: 2, timeoutMs: 500, ...overrides
    });
}
function history(rowsA = tx, rowsB = tx) {
    return {
        historyComplete: true,
        tonapiTransactions: rowsA.map(row => toProvider(row, "tonapi")),
        toncenterTransactions: rowsB.map(row => toProvider(row, "toncenter-v3"))
    };
}
function fixture(t, { chainSeqno = 43 } = {}) {
    const root = mkdtempSync(join(tmpdir(), "ww-outgoing-confirm-"));
    let persistence;
    function open() {
        persistence = new TonFinancialPersistence({ dataDir: join(root, "data") });
        persistence.initialize();
        const journal = new RoomWalletOutboundIntentJournal({ financialPersistence: persistence });
        const gate = new RoomWalletSingleWriterGate({
            directory: join(root, "locks"), intentJournal: journal
        });
        const finalizer = new RoomWalletOutboundChainFinalizer({
            intentJournal: journal, walletGate: gate,
            chain: { async getSeqno() { return chainSeqno; } }
        });
        return { journal, persistence, gate, finalizer };
    }
    t.after(() => {
        persistence?.shutdown({ checkpoint: false });
        rmSync(root, { recursive: true, force: true });
    });
    const first = open();
    const obligationId = "rwrefund_" + "a".repeat(64);
    first.persistence.createRecoveryDataRecord({
        recoveryRecordId: obligationId, kind: "ROOM_WALLET_REFUND_OBLIGATION",
        status: "ACTIVE", state: "REFUND_RECONCILIATION_REQUIRED",
        network: "testnet", executionAllowed: true,
        roomId: "oj7v", roomNumber: 1,
        gameId: "game_oj7v", paymentSessionId: "payment_oj7v",
        playerId: "Olga", fromRoomWallet: ROOM, recipientWallet: OLGA,
        grossRefundNano: "1000000000"
    }, { recoveryRecordId: obligationId, status: "ACTIVE",
        roomId: "oj7v", gameId: "game_oj7v", tonNetwork: "testnet" });
    const intentId = first.journal.createRefundPlan({
        obligationId, netRefundNano: "998611722",
        recipientGasChargeNano: "1388278", frozenGasPlanHash: "e".repeat(64)
    }).intentId;
    const lock = first.gate.acquire({ intentId });
    first.journal.holdSignedMessage({
        intentId, seqno: 42, signedExternalMessageHash: SIGNED,
        signedValidUntil: 1792901100, validUntil: 1792901100
    });
    first.journal.markConfirmationUnknown(intentId);
    return { root, first, intentId, lock, open };
}

test("outgoing scanner paginates both APIs backwards across prior games", async () => {
    const mocked = makeFetch();
    const result = await query(mocked.fetchImpl);
    assert.equal(result.historyComplete, true);
    assert.equal(result.tonapiTransactions.length, 3);
    assert.equal(result.toncenterTransactions.length, 3);
    assert.equal(result.scannedPages.tonapi, 2);
    assert.equal(result.scannedPages.toncenterV3, 2);
    assert.ok(mocked.calls.some(call => call.url.includes("before_lt=304")));
    assert.ok(mocked.calls.some(call => call.url.includes("end_lt=303")));
    assert.equal(result.refundOrRebroadcastAuthorized, false);
});

test("scanner fails closed when provider HTTP 542, never declaring not sent", async () => {
    await assert.rejects(query(makeFetch({ httpFailure: "toncenter-v3" }).fetchImpl),
        error => error.code === "OUTGOING_SCAN_HTTP_FAILURE");
});

test("scanner rejects cursor loops and full-page truncation", async () => {
    await assert.rejects(query(makeFetch({ ignoreCursor: true }).fetchImpl),
        error => error.code === "OUTGOING_SCAN_ORDER_OR_HASH_INVALID");
    await assert.rejects(query(makeFetch().fetchImpl, { maxPagesPerProvider: 1 }),
        error => error.code === "OUTGOING_SCAN_PAGE_BUDGET_EXCEEDED");
});

test("read-only worker recovers signed intent with exact two-provider proof", async t => {
    const f = fixture(t);
    assert.equal(f.first.journal.listUnresolvedSignedIntents().length, 1);
    const worker = new RoomWalletOutboundConfirmationWorker({
        journal: f.first.journal, walletGate: f.first.gate,
        finalizer: f.first.finalizer, scanner: async () => history()
    });
    const report = await worker.runOnce();
    assert.equal(report.attempted, 1);
    assert.equal(report.confirmed, 1);
    assert.equal(report.failed, 0);
    assert.equal(f.first.journal.listUnresolvedSignedIntents().length, 0);
    assert.equal(f.first.gate.isLocked(ROOM), false);
    assert.equal(f.first.journal.load(f.intentId).payload.state, "CHAIN_CONFIRMED");
    assert.equal(typeof worker.broadcastSignedBoc, "undefined");
    worker.shutdown();
});

test("indexer missing outgoing receipt keeps signed lock and UNKNOWN after restart", async t => {
    const f = fixture(t);
    f.first.persistence.shutdown({ checkpoint: false });
    const recovered = f.open();
    const worker = new RoomWalletOutboundConfirmationWorker({
        journal: recovered.journal, walletGate: recovered.gate,
        finalizer: recovered.finalizer,
        scanner: async () => history(tx, tx.slice(1))
    });
    const report = await worker.runOnce();
    assert.equal(report.unknown, 1);
    assert.equal(recovered.gate.isLocked(ROOM), true);
    assert.equal(recovered.journal.load(f.intentId).payload.state, "CONFIRMATION_UNKNOWN");
    worker.shutdown();
});

test("provider outage applies backoff with ZERO automatic rebroadcasts", async t => {
    const f = fixture(t);
    let at = 1792902000000;
    let calls = 0;
    const worker = new RoomWalletOutboundConfirmationWorker({
        journal: f.first.journal, walletGate: f.first.gate,
        finalizer: f.first.finalizer, now: () => at,
        failureRetryMs: 1000,
        scanner: async () => { calls++; throw new Error("HTTP 542"); }
    });
    assert.equal((await worker.runOnce()).failed, 1);
    assert.equal((await worker.runOnce()).attempted, 0);
    at += 1100;
    assert.equal((await worker.runOnce()).failed, 1);
    assert.equal(calls, 2);
    assert.equal(f.first.gate.isLocked(ROOM), true);
    worker.shutdown();
});

test("confirmed persistence after crash reclaims only its own stale signer lock", async t => {
    const f = fixture(t);
    const evidence = {
        confirmed: true, state: "CHAIN_CONFIRMED",
        receipt: {
            account: ROOM, recipient: OLGA, valueNano: "998611722",
            roomWalletTxHash: SOURCE_TX_HASH, roomWalletTxLt: "305",
            outboundMessageHash: OUT,
            signedExternalMessageHash: SIGNED
        }
    };
    f.first.journal.confirmWithChainProof({
        intentId: f.intentId, evidence, observedSeqno: 43
    });
    assert.equal(f.first.gate.isLocked(ROOM), true);
    f.first.persistence.shutdown({ checkpoint: false });
    const recovered = f.open();
    const worker = new RoomWalletOutboundConfirmationWorker({
        journal: recovered.journal, walletGate: recovered.gate,
        finalizer: recovered.finalizer,
        scanner: async () => { throw new Error("MUST_NOT_SCAN_SETTLED"); }
    });
    const report = await worker.runOnce();
    assert.equal(report.recoveredSettledLocks, 1);
    assert.equal(report.attempted, 0);
    assert.equal(recovered.gate.isLocked(ROOM), false);
    worker.shutdown();
});

test("unconfirmed signed attempt cannot be unblocked by restart cleanup", async t => {
    const f = fixture(t);
    const result = f.first.gate.recoverConfirmedLocks();
    assert.equal(result.released, 0);
    assert.equal(result.stillHeld, 1);
    assert.equal(f.first.gate.isLocked(ROOM), true);
});

test("50 uncertain wallet operations run at most two scans per sweep", async () => {
    const items = Array.from({ length: 50 }, (_, n) => ({
        recordId: "rwout_" + n.toString(16).padStart(64, "0"),
        status: "ACTIVE",
        payload: {
            signedValidUntil: 1792901100,
            signedExternalMessageHash: SIGNED,
            roomWallet: "0:" + (n+1).toString(16).padStart(64, "0")
        }
    }));
    let scans = 0;
    const worker = new RoomWalletOutboundConfirmationWorker({
        journal: { listUnresolvedSignedIntents() { return items; } },
        walletGate: { recoverConfirmedLocks() {
            return { released: 0, failed: 0 };
        }},
        finalizer: { async reconcile() { return { state: "CONFIRMATION_UNKNOWN" }; } },
        scanner: async () => { scans++; return {
            historyComplete: true, tonapiTransactions: [], toncenterTransactions: []
        }; },
        now: () => 1792902000000
    });
    for (let i=0; i<25; i++) {
        const step = await worker.runOnce();
        assert.equal(step.attempted, 2);
        assert.equal(step.pending, 50);
    }
    assert.equal(scans, 50);
    worker.shutdown();
});

test("shutdown during asynchronous index read never modifies settled records", async t => {
    const f = fixture(t);
    let finish;
    const wait = new Promise(resolve => { finish = resolve; });
    const worker = new RoomWalletOutboundConfirmationWorker({
        journal: f.first.journal, walletGate: f.first.gate,
        finalizer: f.first.finalizer, scanner: async () => wait
    });
    const run = worker.runOnce();
    assert.equal((await worker.runOnce()).skipped, "in_flight");
    worker.shutdown();
    finish(history());
    await run;
    assert.equal(f.first.journal.load(f.intentId).payload.state, "CONFIRMATION_UNKNOWN");
    assert.equal(f.first.gate.isLocked(ROOM), true);
});
