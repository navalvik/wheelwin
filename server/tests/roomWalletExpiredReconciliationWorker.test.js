import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TonFinancialPersistence } from "../persistence/TonFinancialPersistence.js";
import { RoomWalletRefundRecoveryRepository } from "../payment/roomWallet/RoomWalletRefundRecoveryRepository.js";
import { RoomWalletExpiredReconciliationWorker } from "../payment/roomWallet/RoomWalletExpiredReconciliationWorker.js";

const ROOM = "0:c6423c1a3f43921316bd31f66287ad437b94d0b9421340f622619c9fa80173a6";
const players = [
    { name: "Olga", wallet: "0:bdab0280cbbda45f5a0fb6bc97fa0e72e380769986440761d574901e269ae56b", hash: "488351bef406163cf3fc0546e53d6472324e77b787a56a628f1e24c776d99ca3", lt: "105264227000003", utime: 1792892552 },
    { name: "Lena", wallet: "0:de5819f3012bf5bb3f0e502aa3a066ffcab5bf4d52dcf384b9b33a857e3907c8", hash: "42e85d64a448206c739b0a953ca22ba0368409425c193ec0bfd4409aceaba72a", lt: "105264234000003", utime: 1792892555 },
    { name: "Bob", wallet: "0:2d8205bb979c1f41c3f2cb7f18ee656e5e7874c111dca4528f21db426dc4476f", hash: "a3692566ccc78cf87097af572aa573aaf6c0b460c8d11182c5a4850b8a68f5ef", lt: "105264240000003", utime: 1792892557 }
];
const txs = players.map(p => ({
    success: true,
    transaction_id: { lt: p.lt, hash: p.hash },
    utime: p.utime,
    in_msg: { source: p.wallet, destination: ROOM, value: "1000000000" }
}));
function evidence(rows = txs) {
    return { source: "tonapi+toncenter-v3", transactions: rows, historyComplete: true,
        awaitingSecondProvider: 0, walletReleaseAuthorized: false };
}
function sessionFor(number = 1) {
    return {
        network: "testnet",
        roomId: number === 1 ? "oj7v" : "room_" + number,
        roomNumber: number,
        gameId: number === 1
            ? "game_c2e30d65-2194-432f-8cc5-267d935e8fc4" : "game_" + number,
        paymentSessionId: number === 1
            ? "pay_cf9ef2f2-1026-4916-80f8-92392904a44a" : "pay_" + number,
        roomWalletAddress: number === 1
            ? ROOM : "0:" + number.toString(16).padStart(64, "0"),
        createdAt: 1792892541339,
        paymentDeadline: 1792893021339,
        receivedPayments: [],
        participants: players.map(p => ({
            playerId: p.name, wallet: p.wallet, requiredGram: 1,
            status: "BLOCKCHAIN_PENDING", refunded: false
        }))
    };
}
function fixture(t) {
    const dir = mkdtempSync(join(tmpdir(), "ww-expiryworker-"));
    let persistence;
    const open = () => {
        persistence = new TonFinancialPersistence({ dataDir: dir });
        persistence.initialize();
        const repo = new RoomWalletRefundRecoveryRepository({
            financialPersistence: persistence
        });
        return { repo, persistence };
    };
    t.after(() => {
        persistence?.shutdown({ checkpoint: false });
        rmSync(dir, { recursive: true, force: true });
    });
    const add = ({ persistence, repo }, n) => {
        const session = sessionFor(n);
        persistence.createPaymentSession(session, {
            paymentSessionId: session.paymentSessionId,
            roomId: session.roomId,
            gameId: session.gameId, tonNetwork: "testnet"
        });
        repo.beginQuarantine({
            roomId: session.roomId, roomNumber: session.roomNumber,
            gameId: session.gameId,
            paymentSessionId: session.paymentSessionId,
            roomWallet: session.roomWalletAddress
        });
        return session;
    };
    return { open, add };
}

test("oj7v: closed-room worker independently restores 3 deposits after expiry", async t => {
    const f = fixture(t);
    const a = f.open();
    f.add(a, 1);
    let calls = 0;
    const worker = new RoomWalletExpiredReconciliationWorker({
        repository: a.repo, financialPersistence: a.persistence,
        scanner: async () => { calls++; return evidence(); }
    });
    const result = await worker.runOnce();
    assert.equal(result.attempted, 1);
    assert.equal(result.newObligations, 3);
    assert.equal(result.failures, 0);
    assert.equal(calls, 1);
    assert.equal(a.repo.isRoomNumberQuarantined(1), true);
    assert.equal(a.repo.listRefundObligations().length, 3);
    assert.equal(typeof worker.broadcastTransaction, "undefined");
    worker.shutdown();
});

test("restart-safe replay with the same receipts does not create duplicate debts", async t => {
    const f = fixture(t);
    const a = f.open();
    f.add(a, 1);
    await new RoomWalletExpiredReconciliationWorker({
        repository: a.repo, financialPersistence: a.persistence,
        scanner: async () => evidence()
    }).runOnce();
    a.persistence.shutdown({ checkpoint: false });
    const recovered = f.open();
    let now = 1792900000000;
    const worker = new RoomWalletExpiredReconciliationWorker({
        repository: recovered.repo, financialPersistence: recovered.persistence,
        now: () => now,
        scanner: async () => evidence(),
        successRetryMs: 1000
    });
    const result = await worker.runOnce();
    assert.equal(result.newObligations, 0);
    assert.equal(recovered.repo.listRefundObligations().length, 3);
    assert.equal(recovered.repo.isRoomNumberQuarantined(1), true);
    worker.shutdown();
});

test("zero deposits today never unlock the room; later matching deposits become debts", async t => {
    const f = fixture(t);
    const a = f.open();
    f.add(a, 1);
    let now = 1792900000000;
    let paid = false;
    const worker = new RoomWalletExpiredReconciliationWorker({
        repository: a.repo, financialPersistence: a.persistence,
        now: () => now,
        successRetryMs: 1000,
        scanner: async () => paid ? evidence() : evidence([])
    });
    const first = await worker.runOnce();
    assert.equal(first.newObligations, 0);
    assert.equal(a.repo.isRoomNumberQuarantined(1), true);
    paid = true;
    now += 1100;
    const second = await worker.runOnce();
    assert.equal(second.newObligations, 3);
    assert.equal(a.repo.isRoomNumberQuarantined(1), true);
    worker.shutdown();
});

test("HTTP 542 triggers durable pending quarantine and bounded retry backoff", async t => {
    const f = fixture(t);
    const a = f.open();
    f.add(a, 1);
    let now = 1792900000000;
    let attempts = 0;
    const worker = new RoomWalletExpiredReconciliationWorker({
        repository: a.repo, financialPersistence: a.persistence,
        now: () => now,
        failureRetryMs: 1000,
        scanner: async () => { attempts++; throw new Error("HTTP 542"); }
    });
    assert.equal((await worker.runOnce()).failures, 1);
    assert.equal((await worker.runOnce()).attempted, 0);
    now += 1100;
    assert.equal((await worker.runOnce()).failures, 1);
    assert.equal((await worker.runOnce()).attempted, 0);
    assert.equal(attempts, 2);
    assert.equal(a.repo.isRoomNumberQuarantined(1), true);
    assert.equal(a.repo.listRefundObligations().length, 0);
    worker.shutdown();
});

test("50 simultaneous expired rooms are drained at most 2 per sweep", async t => {
    const f = fixture(t);
    const a = f.open();
    for (let n = 1; n <= 50; n++) f.add(a, n);
    let calls = 0;
    const worker = new RoomWalletExpiredReconciliationWorker({
        repository: a.repo, financialPersistence: a.persistence,
        maxWalletsPerSweep: 2,
        scanner: async () => { calls++; return evidence([]); },
        successRetryMs: 100000
    });
    const result = await worker.runOnce();
    assert.equal(result.pendingQuarantines, 50);
    assert.equal(result.attempted, 2);
    assert.equal(calls, 2);
    assert.equal(a.repo.listOpenQuarantines().length, 50);
    for (let i = 0; i < 24; i++) {
        const step = await worker.runOnce();
        assert.ok(step.attempted <= 2);
    }
    assert.equal(calls, 50);
    assert.equal(a.repo.listOpenQuarantines().length, 50);
    worker.shutdown();
});

test("failed payment-session identity or incomplete scan never creates unsafe debt", async t => {
    const f = fixture(t);
    const a = f.open();
    f.add(a, 1);
    const record = a.persistence.loadPaymentSession(sessionFor().paymentSessionId);
    a.persistence.updatePaymentSession(sessionFor().paymentSessionId, {
        ...record.payload, roomWalletAddress: players[0].wallet
    });
    const worker = new RoomWalletExpiredReconciliationWorker({
        repository: a.repo, financialPersistence: a.persistence,
        scanner: async () => evidence()
    });
    const out = await worker.runOnce();
    assert.equal(out.failures, 1);
    assert.equal(a.repo.listRefundObligations().length, 0);
    assert.equal(a.repo.isRoomNumberQuarantined(1), true);
    worker.shutdown();
});

test("overlapping sweeps are skipped and shutdown prevents late writes", async t => {
    const f = fixture(t);
    const a = f.open();
    f.add(a, 1);
    let resolve;
    const pending = new Promise(r => { resolve = r; });
    const worker = new RoomWalletExpiredReconciliationWorker({
        repository: a.repo, financialPersistence: a.persistence,
        scanner: async () => pending
    });
    const running = worker.runOnce();
    assert.equal((await worker.runOnce()).skipped, "in_flight");
    worker.shutdown();
    resolve(evidence());
    await running;
    assert.equal(a.repo.listRefundObligations().length, 0);
    assert.equal((await worker.runOnce()).skipped, "stopped");
});
