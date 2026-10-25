import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TonFinancialPersistence } from "../persistence/TonFinancialPersistence.js";
import { RoomWalletOutboundIntentJournal } from "../payment/roomWallet/RoomWalletOutboundIntentJournal.js";
import { RoomWalletResidualSweepRepository } from "../payment/roomWallet/RoomWalletResidualSweepRepository.js";
import { RoomWalletGuardedPayoutCoordinator } from "../payment/roomWallet/RoomWalletGuardedPayoutCoordinator.js";
import { RoomWalletResidualSweepWorker } from "../payment/roomWallet/RoomWalletResidualSweepWorker.js";

const ROOM = "0:c6423c1a3f43921316bd31f66287ad437b94d0b9421340f622619c9fa80173a6";
const RESIDUES = "0:d012345678901234567890123456789012345678901234567890123456789012";
const GAME = "game_valid_completed";
const ROOM_ID = "room_paid";
const SETTLEMENT = "settlement_valid";
function fixture(t, options = {}) {
    const dir = mkdtempSync(join(tmpdir(), "ww-guarded-sweep-"));
    const db = new TonFinancialPersistence({ dataDir: dir });
    db.initialize();
    t.after(() => {
        db.shutdown({ checkpoint: false });
        rmSync(dir, { recursive: true, force: true });
    });
    const sweeps = new RoomWalletResidualSweepRepository({ persistence: db });
    const journal = new RoomWalletOutboundIntentJournal({
        financialPersistence: db,
        roomWalletRegistry: { get(n) { return n === 1
            ? { roomNumber: 1, address: ROOM } : null; } }
    });
    const settlement = {
        settlementSessionId: SETTLEMENT, gameId: GAME,
        network: "testnet", roomId: ROOM_ID,
        status: "SETTLEMENT_COMPLETED",
        request: {
            gameId: GAME, roomId: ROOM_ID, roomNumber: 1,
            payoutPlan: { mode: "RECIPIENT_PAYS_GAS" }
        }
    };
    db.createSettlementRecord(settlement, {
        gameId: GAME, roomId: ROOM_ID, tonNetwork: "testnet",
        status: "SETTLEMENT_COMPLETED"
    });
    function addPayout(role, confirmed = true) {
        const id = "rwout_" + (role === "WINNER" ? "a" : "b").repeat(64);
        db.createRecoveryDataRecord({
            recoveryRecordId: id,
            kind: "ROOM_WALLET_OUTBOUND_INTENT",
            role, network: "testnet",
            status: confirmed ? "SETTLED" : "ACTIVE",
            state: confirmed ? "CHAIN_CONFIRMED" : "CONFIRMATION_UNKNOWN",
            gameId: GAME, roomId: ROOM_ID, roomNumber: 1,
            roomWallet: ROOM,
            chainReceipt: confirmed ? { walletTxHash: "c".repeat(64) } : null
        }, { recoveryRecordId: id, status: confirmed ? "SETTLED" : "ACTIVE",
            gameId: GAME, roomId: ROOM_ID, tonNetwork: "testnet" });
    }
    if (options.winner !== false) addPayout("WINNER");
    if (options.owner !== false) addPayout("OWNER");
    function createSweep({ gameId = GAME, amountNano = 490_000_000n } = {}) {
        return sweeps.create({
            gameId, roomNumber: 1, sourceAddress: ROOM,
            destinationAddress: RESIDUES,
            observedBalanceNano: 500_000_000n,
            amountNano
        });
    }
    return { db, sweeps, journal, createSweep, addPayout };
}

test("0.49 GRAM sweep is frozen with source-paid 0.006 gas envelope", t => {
    const f = fixture(t);
    const s = f.createSweep();
    const result = f.journal.createResidualSweepPlan({ sweepRecordId: s.recordId });
    assert.equal(result.created, true);
    const entry = f.journal.load(result.intentId).payload;
    assert.equal(entry.role, "SWEEP");
    assert.equal(entry.feePaymentMode, "SOURCE_PAYS_GAS");
    assert.equal(entry.transferNano, "490000000");
    assert.equal(entry.gasChargeNano, "6000000");
    assert.equal(entry.sourceRetainedFloorNano, "10000000");
    assert.equal(entry.roomWallet, ROOM);
    assert.equal(entry.destinationWallet, RESIDUES);
    assert.equal(entry.broadcastingEnabled, false);
    assert.equal(typeof f.journal.broadcast, "undefined");
    assert.equal(f.journal.createResidualSweepPlan({ sweepRecordId: s.recordId }).created, false);
});

test("no settlement winner/owner receipt means no sweep intent", t => {
    const f = fixture(t, { owner: false });
    const s = f.createSweep();
    assert.throws(() => f.journal.createResidualSweepPlan({
        sweepRecordId: s.recordId
    }), e => e.code === "OUTBOUND_SWEEP_WINNER_OR_OWNER_UNPAID");
});

test("sweep without exact settlement game cannot adopt previous room payout", t => {
    const f = fixture(t);
    const s = f.createSweep({ gameId: "another_game" });
    assert.throws(() => f.journal.createResidualSweepPlan({
        sweepRecordId: s.recordId
    }), e => e.code === "OUTBOUND_SWEEP_SETTLEMENT_NOT_FINAL");
});

test("old sweep lacking game identity fails closed, never matches by room number only", t => {
    const f = fixture(t);
    const s = f.createSweep({ gameId: null });
    assert.throws(() => f.journal.createResidualSweepPlan({
        sweepRecordId: s.recordId
    }), e => e.code === "OUTBOUND_SWEEP_FROZEN_GAME_ID_REQUIRED");
});

test("modified 0.49 transfer or gas policy cannot become a signed sweep", t => {
    const f = fixture(t);
    const s = f.createSweep({ amountNano: 480_000_000n });
    assert.throws(() => f.journal.createResidualSweepPlan({
        sweepRecordId: s.recordId
    }), e => e.code === "OUTBOUND_SWEEP_POLICY_MISMATCH");
});

test("pending refund debt prevents consuming money as residual", t => {
    const f = fixture(t);
    const id = "rwrefund_" + "e".repeat(64);
    f.db.createRecoveryDataRecord({
        recoveryRecordId: id,
        kind: "ROOM_WALLET_REFUND_OBLIGATION",
        roomId: ROOM_ID, network: "testnet",
        status: "ACTIVE", state: "REFUND_RECONCILIATION_REQUIRED"
    }, { recoveryRecordId: id, roomId: ROOM_ID,
        gameId: GAME, status: "ACTIVE", tonNetwork: "testnet" });
    const s = f.createSweep();
    assert.throws(() => f.journal.createResidualSweepPlan({
        sweepRecordId: s.recordId
    }), e => e.code === "OUTBOUND_SWEEP_REFUND_DEBT_PRESENT");
});

test("durable sweep plan is preserved across financial store restart", t => {
    const f = fixture(t);
    const s = f.createSweep();
    const first = f.journal.createResidualSweepPlan({ sweepRecordId: s.recordId });
    assert.equal(first.created, true);
    f.db.checkpoint?.();
    const reread = f.journal.load(first.intentId);
    assert.equal(reread.payload.authorizationId, s.recordId);
    assert.equal(reread.payload.gameId, GAME);
});


test("guarded residual transfer is sent once, remains unknown, then chain proof finalizes", async t => {
    const f = fixture(t);
    const sweep = f.createSweep();
    let executed = 0;
    const coordinator = new RoomWalletGuardedPayoutCoordinator({
        journal: f.journal,
        residualSweepRepository: f.sweeps,
        executor: {
            async execute({ intentId }) {
                const state = f.journal.load(intentId);
                if (state.payload.state !== "PLANNED") {
                    return { state: "CONFIRMATION_UNKNOWN", broadcasted: false };
                }
                executed++;
                f.journal.holdSignedMessage({
                    intentId, seqno: 41,
                    signedExternalMessageHash: "e".repeat(64),
                    validUntil: 1792902000
                });
                f.journal.markConfirmationUnknown(intentId);
                return { state: "CONFIRMATION_UNKNOWN", broadcasted: true };
            }
        }
    });
    const first = await coordinator.sweepResidual({ sweepRecordId: sweep.recordId });
    assert.equal(first.code, "GUARDED_SWEEP_CONFIRMATION_PENDING");
    assert.equal(executed, 1);
    assert.equal(f.sweeps.findById(sweep.recordId).payload.status, "AWAITING_TRANSACTION_HASH");
    const second = await coordinator.sweepResidual({ sweepRecordId: sweep.recordId });
    assert.equal(second.code, "GUARDED_SWEEP_CONFIRMATION_PENDING");
    assert.equal(executed, 1);
    const intent = f.journal.createResidualSweepPlan({ sweepRecordId: sweep.recordId });
    f.journal.confirmWithChainProof({
        intentId: intent.intentId,
        observedSeqno: 42,
        evidence: {
            confirmed: true, state: "CHAIN_CONFIRMED",
            receipt: {
                account: ROOM, recipient: RESIDUES, valueNano: "490000000",
                signedExternalMessageHash: "e".repeat(64),
                roomWalletTxHash: "f".repeat(64),
                roomWalletTxLt: "19000001",
                outboundMessageHash: "a".repeat(64)
            }
        }
    });
    const last = await coordinator.sweepResidual({ sweepRecordId: sweep.recordId });
    assert.equal(last.ok, true);
    assert.equal(last.txHash, "f".repeat(64));
    assert.equal(f.sweeps.findById(sweep.recordId).payload.status, "CONFIRMED");
    const repeated = await coordinator.sweepResidual({ sweepRecordId: sweep.recordId });
    assert.equal(repeated.ok, true);
    assert.equal(repeated.repeated, true);
    assert.equal(executed, 1);
});

test("unknown prior legacy processing without a journal is never treated as a fresh sweep", t => {
    const f = fixture(t);
    const sweep = f.createSweep();
    f.sweeps.markProcessing(sweep.recordId);
    assert.throws(() => f.journal.createResidualSweepPlan({
        sweepRecordId: sweep.recordId
    }), e => e.code === "OUTBOUND_SWEEP_UNKNOWN_LEGACY_ATTEMPT");
});

test("guarded sweep worker cannot fall through into legacy direct sendTransfer", async t => {
    const f = fixture(t);
    const sweep = f.createSweep();
    let directSends = 0;
    let guardedCalls = 0;
    const worker = new RoomWalletResidualSweepWorker({
        repository: f.sweeps,
        env: { ROOM_WALLET_GUARDED_OUTBOUND_ONLY: "true" },
        roomWalletAdapter: {
            async sendTransfer() { directSends++; throw new Error("UNSAFE"); }
        },
        guardedPayoutCoordinator: {
            async sweepResidual({ sweepRecordId }) {
                guardedCalls++;
                assert.equal(sweepRecordId, sweep.recordId);
                return { ok: false, code: "GUARDED_SWEEP_CONFIRMATION_PENDING" };
            }
        }
    });
    const r = await worker._submitExisting(sweep.recordId);
    assert.equal(r.code, "GUARDED_SWEEP_CONFIRMATION_PENDING");
    assert.equal(guardedCalls, 1);
    assert.equal(directSends, 0);
});

test("guarded sweep event watcher cannot mark a transfer confirmed by tx hash alone", async t => {
    const f = fixture(t);
    const sweep = f.createSweep();
    const worker = new RoomWalletResidualSweepWorker({
        repository: f.sweeps,
        env: { ROOM_WALLET_GUARDED_OUTBOUND_ONLY: "true" }
    });
    const r = await worker.confirmByTransactionHash("f".repeat(64));
    assert.equal(r.code, "GUARDED_SWEEP_CHAIN_PROOF_REQUIRED");
    assert.equal(f.sweeps.findById(sweep.recordId).payload.status, "PENDING");
});


test("repeated settlement event cannot sweep the same game's later balance twice", t => {
    const f = fixture(t);
    const first = f.createSweep();
    f.sweeps.markConfirmed(first.recordId, { txHash: "a".repeat(64) });
    assert.throws(() => f.createSweep(), e => e.name === "DuplicateRecordError");
    assert.equal(f.sweeps.listActive().length, 1);
});


test("stale settlement event cannot sweep funds of newer game in recycled room wallet", t => {
    const f = fixture(t);
    const settle = f.db.loadSettlementRecord(GAME);
    f.db.createPaymentSession({
        roomId: "room_new",
        roomNumber: 1,
        gameId: "game_new_players",
        paymentSessionId: "pay_new",
        network: "testnet",
        roomWalletAddress: ROOM,
        createdAt: Number(settle.createdAt) + 1000
    }, {
        paymentSessionId: "pay_new",
        roomId: "room_new",
        gameId: "game_new_players",
        tonNetwork: "testnet",
        createdAt: Number(settle.createdAt) + 1000
    });
    const sweep = f.createSweep({ gameId: GAME });
    assert.throws(() => f.journal.createResidualSweepPlan({
        sweepRecordId: sweep.recordId
    }), e => e.code === "OUTBOUND_SWEEP_WALLET_ALREADY_REASSIGNED");
});


test("repeated guarded settlement trigger routes AWAITING sweep through proof coordinator", async t => {
    const f = fixture(t);
    const sweep = f.createSweep();
    f.sweeps.markAwaitingTransactionHash(sweep.recordId, { seqno: 42 });
    let guardedCalls = 0, legacyWatches = 0, directSends = 0;
    const worker = new RoomWalletResidualSweepWorker({
        repository: f.sweeps,
        env: { ROOM_WALLET_GUARDED_OUTBOUND_ONLY: "true" },
        roomWalletAdapter: {
            async sendTransfer() { directSends++; throw new Error("UNSAFE"); }
        },
        guardedPayoutCoordinator: {
            async sweepResidual({ sweepRecordId }) {
                guardedCalls++;
                assert.equal(sweepRecordId, sweep.recordId);
                return { ok: false, code: "GUARDED_SWEEP_CONFIRMATION_PENDING" };
            }
        }
    });
    worker._watchExisting = () => { legacyWatches++; };
    const result = await worker._processRoomLocked(1, {
        trigger: "SETTLEMENT_CONFIRMED", gameId: GAME
    });
    assert.equal(result.code, "GUARDED_SWEEP_CONFIRMATION_PENDING");
    assert.equal(guardedCalls, 1);
    assert.equal(legacyWatches, 0);
    assert.equal(directSends, 0);
    assert.equal(f.sweeps.findById(sweep.recordId).payload.status,
        "AWAITING_TRANSACTION_HASH");
});

test("repeated guarded sweep with legacy tx hash never starts a hash-only watcher", async t => {
    const f = fixture(t);
    const sweep = f.createSweep();
    f.sweeps.markSent(sweep.recordId, {
        txHash: "f".repeat(64), seqno: 42
    });
    let guardedCalls = 0, watched = 0;
    const worker = new RoomWalletResidualSweepWorker({
        repository: f.sweeps,
        env: { ROOM_WALLET_GUARDED_OUTBOUND_ONLY: "true" },
        guardedPayoutCoordinator: {
            async sweepResidual({ sweepRecordId }) {
                guardedCalls++;
                assert.equal(sweepRecordId, sweep.recordId);
                return { ok: false, code: "GUARDED_SWEEP_PROOF_NOT_AUTHORIZED" };
            }
        }
    });
    worker._watchExisting = () => { watched++; };
    const result = await worker._processRoomLocked(1, {
        trigger: "SETTLEMENT_CONFIRMED", gameId: GAME
    });
    assert.equal(result.code, "GUARDED_SWEEP_PROOF_NOT_AUTHORIZED");
    assert.equal(guardedCalls, 1);
    assert.equal(watched, 0);
    assert.equal(f.sweeps.findById(sweep.recordId).payload.txHash,
        "f".repeat(64));
});
