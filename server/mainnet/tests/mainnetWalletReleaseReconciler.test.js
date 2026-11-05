import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadMainnetRuntimeConfig } from "../config/MainnetRuntimeConfig.js";
import { MainnetFinancialLedger } from "../payment/MainnetFinancialLedger.js";
import { MainnetWalletReleaseReconciler } from "../wallet/MainnetWalletReleaseReconciler.js";
import { MainnetWalletPoolRegistry } from "../wallet/MainnetWalletPoolRegistry.js";

const NOW = 1_900_000_000_000;
const PAYER = `0:${"a".repeat(64)}`;
const SOURCE = `0:${"b".repeat(64)}`;
const WINNER = `0:${"c".repeat(64)}`;
const OWNER = `0:${"d".repeat(64)}`;

function makeHarness(t, { activeRoomIds = [] } = {}) {
    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-mainnet-wallet-release-"));
    t.after(() => rmSync(dataDir, { recursive: true, force: true }));
    const walletCatalog = JSON.stringify(Array.from({ length: 64 }, (_, index) => ({
        walletId: `wallet-${index + 1}`, roomNumber: index + 1,
        address: `0:${String(index + 1).padStart(64, "0")}`, network: "mainnet"
    })));
    const config = loadMainnetRuntimeConfig({ TON_NETWORK: "mainnet",
        MAINNET_TONCENTER_API_KEY: "offline-test-key", MAINNET_ROOM_WALLET_DATA_DIR: dataDir,
        MAINNET_ROOM_WALLETS_JSON: walletCatalog });
    const snapshotDir = join(dataDir, "wallet-registry");
    const pool = new MainnetWalletPoolRegistry({ config });
    pool.initialize({ snapshotDir });
    const ledger = new MainnetFinancialLedger({ config, nowProvider: () => NOW }).initialize();
    const active = new Set(activeRoomIds);
    const roomManager = { getRoom: roomId => active.has(roomId) ? { roomId } : null };
    const wallet = pool.getWalletByRoomNumber(1);
    const reserve = (roomId, now = NOW - 10_000) => {
        if (pool.isQuarantined(1)) pool.manuallyReleaseQuarantine({ roomNumber: 1, verifiedSafe: true });
        const reservation = pool.reserve({ roomId, network: "mainnet", walletId: wallet.walletId, now });
        pool.manuallyQuarantine(1, { note: "simulate an existing reservation when the Mainnet hold is applied" });
        return reservation;
    };
    const reconciler = financialLedger => new MainnetWalletReleaseReconciler({ walletPool: pool,
        financialLedger: financialLedger ?? ledger, roomManager, snapshotDir,
        nowProvider: () => NOW, maxPerPass: 3 });
    return { dataDir, config, snapshotDir, pool, ledger, wallet, reserve, active, reconciler };
}

function incomingWithOneConfirmed(roomId) {
    const intents = Array.from({ length: 3 }, (_, index) => ({
        paymentReference: `release-ref-${index}`, roomId, playerId: `player-${index}`,
        network: "mainnet", globalId: -239, asset: "TON", state: index === 0 ? "SETTLED" : "PENDING",
        confirmedTransactionId: index === 0 ? "incoming-release" : null,
        amountAtomic: "1000000000", expectedSender: PAYER, destinationWalletAddress: SOURCE
    }));
    return { network: "mainnet", globalId: -239,
        listRoomIntents: () => intents,
        listReceipts: () => [{ network: "mainnet", globalId: -239, status: "CONFIRMED", reason: null,
            roomId, transactionId: "incoming-release", asset: "TON", paymentReference: "release-ref-0",
            playerId: "player-0", amountAtomic: "1000000000", sourceAddress: PAYER,
            destinationAddress: SOURCE, transactionTime: NOW - 5_000 }],
        listObservations: () => [{ network: "mainnet", globalId: -239, roomId,
            transactionId: "incoming-release", payloadFingerprint: "a".repeat(64),
            sourceAddress: PAYER, destinationAddress: SOURCE, amountAtomic: "1000000000",
            asset: "TON", transactionTime: NOW - 5_000, observedAt: NOW - 4_000 }] };
}

function completeRefund(ledger, roomId) {
    ledger.recordClosedRoom({ roomId, roomNumber: 1, closureReason: "setup_expired", prePage5: true });
    const [refund] = ledger.prepareRefunds({ roomId, roomNumber: 1, closureReason: "setup_expired",
        incomingLedger: incomingWithOneConfirmed(roomId) });
    ledger.updateRefund(refund.obligationId, { state: "SUBMISSION_UNKNOWN",
        transferAmountAtomic: 900_000_000, gasChargeAtomic: 100_000_000 });
    ledger.updateRefund(refund.obligationId, { state: "SUBMITTED", outgoingTransactionId: "refund-out" });
    ledger.updateRefund(refund.obligationId, { state: "COMPLETE", finalizedEvidence: {
        network: "mainnet", globalId: -239, transactionId: "refund-out",
        amountAtomic: 900_000_000, destination: PAYER, finalized: true
    } });
}

function createPayout(ledger, roomId) {
    return ledger.createPayout({ payoutId: `payout_${roomId}`, roomId, roomNumber: 1,
        sourceWalletAddress: SOURCE, principalAtomic: 100_000_000,
        winner: { recipientId: "winner", address: WINNER },
        owner: { recipientId: "owner", address: OWNER } });
}

function confirmLeg(ledger, payoutId, role) {
    ledger.updatePayoutLeg(payoutId, role, { state: "SUBMISSION_UNKNOWN" });
    ledger.updatePayoutLeg(payoutId, role, { state: "CONFIRMED", transactionId: `${role}-out` });
}

test("destroyed room with no blocking obligations releases wallet once and preserves ownership history", async t => {
    const h = makeHarness(t);
    h.reserve("closed-empty");
    h.ledger.recordClosedRoom({ roomId: "closed-empty", roomNumber: 1,
        closureReason: "setup_expired", prePage5: true });
    h.pool.persistSnapshot(h.snapshotDir);

    const first = await h.reconciler().runPass();
    assert.equal(first.released, 1);
    assert.equal(h.pool.getReservationForRoom("closed-empty"), null);
    const history = h.pool.listReservationHistoryForWallet(h.wallet.walletId);
    assert.equal(history.length, 1);
    assert.equal(history[0].roomId, "closed-empty");
    assert.equal(history[0].releasedAt, NOW);
    assert.deepEqual(h.pool.resolveReservationOwnerAt({ walletId: h.wallet.walletId,
        transactionTime: NOW - 5_000 }), { status: "OWNED", roomId: "closed-empty", candidates: ["closed-empty"] });
    assert.equal((await h.reconciler().runPass()).released, 0, "replay is idempotent");

    h.pool.manuallyReleaseQuarantine({ roomNumber: 1, verifiedSafe: true });
    h.pool.reserve({ roomId: "later-room", network: "mainnet", walletId: h.wallet.walletId, now: NOW + 1 });
    assert.equal(h.pool.resolveReservationOwnerAt({ walletId: h.wallet.walletId,
        transactionTime: NOW + 2 }).roomId, "later-room");
    assert.equal(h.pool.resolveReservationOwnerAt({ walletId: h.wallet.walletId,
        transactionTime: NOW - 5_000 }).roomId, "closed-empty");
    assert.equal(h.pool.getReservationForRoomHistory("closed-empty").walletId, h.wallet.walletId);
    assert.equal(h.pool.getReservationForRoomHistory("later-room").walletId, h.wallet.walletId);

    h.pool.release({ roomId: "later-room", unresolvedObligations: 0, now: NOW + 3 });
    const secondWallet = h.pool.getWalletByRoomNumber(2);
    h.pool.reserve({ roomId: "later-room", network: "mainnet", walletId: secondWallet.walletId, now: NOW + 4 });
    assert.equal(h.pool.getReservationForRoomHistory("later-room"), null,
        "conflicting historical wallet identities fail closed");
});

test("an incomplete refund obligation blocks release until it is complete", async t => {
    const h = makeHarness(t);
    h.reserve("refund-room");
    h.ledger.recordClosedRoom({ roomId: "refund-room", roomNumber: 1,
        closureReason: "setup_expired", prePage5: true });
    const [refund] = h.ledger.prepareRefunds({ roomId: "refund-room", roomNumber: 1,
        closureReason: "setup_expired", incomingLedger: incomingWithOneConfirmed("refund-room") });
    assert.equal((await h.reconciler().runPass()).blocked, 1);
    assert.equal(h.pool.getReservationForRoom("refund-room").walletId, h.wallet.walletId);

    completeRefund(h.ledger, "refund-room");
    const result = await h.reconciler().runPass();
    assert.equal(result.released, 1);
    assert.equal(h.pool.getReservationForRoom("refund-room"), null);
    assert.equal(h.ledger.getRefund(refund.obligationId).state, "COMPLETE");
});

test("unsettled winner payout blocks wallet release, then completion permits it", async t => {
    const h = makeHarness(t);
    h.reserve("payout-room");
    const payout = createPayout(h.ledger, "payout-room");
    confirmLeg(h.ledger, payout.payoutId, "winner");
    assert.equal((await h.reconciler().runPass()).blocked, 1);
    assert.ok(h.pool.getReservationForRoom("payout-room"));
    confirmLeg(h.ledger, payout.payoutId, "owner");
    assert.equal((await h.reconciler().runPass()).released, 1);
    assert.equal(h.pool.getReservationForRoom("payout-room"), null);
});

test("UNPAID_INSUFFICIENT_GAS owner fee does not block reuse after winner is confirmed", async t => {
    const h = makeHarness(t);
    h.reserve("owner-gas-room");
    const payout = createPayout(h.ledger, "owner-gas-room");
    confirmLeg(h.ledger, payout.payoutId, "winner");
    h.ledger.updatePayoutLeg(payout.payoutId, "owner", { state: "UNPAID_INSUFFICIENT_GAS" });
    assert.equal(h.ledger.getPayout(payout.payoutId).state, "PARTIAL_OWNER_UNPAID");
    assert.equal(h.ledger.countWalletBlockingObligations("owner-gas-room"), 0);
    assert.equal((await h.reconciler().runPass()).released, 1);
    assert.equal(h.pool.getReservationForRoom("owner-gas-room"), null);
    assert.equal(h.ledger.getPayout(payout.payoutId).owner.state, "UNPAID_INSUFFICIENT_GAS");
});

test("a live room is never released even when its current wallet blockers are zero", async t => {
    const h = makeHarness(t, { activeRoomIds: ["active-room"] });
    h.reserve("active-room");
    h.ledger.recordClosedRoom({ roomId: "active-room", roomNumber: 1,
        closureReason: "setup_expired", prePage5: true });
    assert.equal((await h.reconciler().runPass()).blocked, 1);
    assert.ok(h.pool.getReservationForRoom("active-room"));
});

test("restart restores the persisted reservation and safely releases it after obligations are clear", async t => {
    const h = makeHarness(t);
    h.reserve("restart-room");
    h.ledger.recordClosedRoom({ roomId: "restart-room", roomNumber: 1,
        closureReason: "setup_expired", prePage5: true });
    h.pool.persistSnapshot(h.snapshotDir);
    const restartedPool = new MainnetWalletPoolRegistry({ config: h.config });
    restartedPool.initialize({ snapshotDir: h.snapshotDir });
    assert.equal(restartedPool.getReservationForRoom("restart-room").walletId, h.wallet.walletId);
    const restarted = new MainnetWalletReleaseReconciler({ walletPool: restartedPool,
        financialLedger: h.ledger, roomManager: { getRoom: () => null },
        snapshotDir: h.snapshotDir, nowProvider: () => NOW });
    assert.equal((await restarted.runPass()).released, 1);
    const afterRestart = new MainnetWalletPoolRegistry({ config: h.config });
    afterRestart.initialize({ snapshotDir: h.snapshotDir });
    assert.equal(afterRestart.getReservationForRoom("restart-room"), null);
    assert.equal(afterRestart.listReservationHistoryForWallet(h.wallet.walletId)[0].releasedAt, NOW);
});

test("ledger errors fail closed and never release a wallet", async t => {
    const h = makeHarness(t);
    h.reserve("ledger-error-room");
    h.ledger.recordClosedRoom({ roomId: "ledger-error-room", roomNumber: 1,
        closureReason: "setup_expired", prePage5: true });
    const unsafeLedger = Object.create(h.ledger);
    unsafeLedger.countWalletBlockingObligations = () => { throw new Error("ledger unavailable"); };
    const result = await h.reconciler(unsafeLedger).runPass();
    assert.equal(result.errors, 1);
    assert.ok(h.pool.getReservationForRoom("ledger-error-room"));
});

test("release scheduler remains idempotent across passes and stops cleanly", async t => {
    const h = makeHarness(t);
    h.reserve("scheduler-room");
    h.ledger.recordClosedRoom({ roomId: "scheduler-room", roomNumber: 1,
        closureReason: "setup_expired", prePage5: true });
    const worker = h.reconciler();
    const first = worker.runPass();
    assert.equal((await first).released, 1);
    assert.equal((await worker.runPass()).released, 0);
    worker.stop();
    assert.equal((await worker.runPass()).status, "STOPPED");
});
