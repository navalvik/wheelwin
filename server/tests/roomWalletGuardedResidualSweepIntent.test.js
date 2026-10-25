import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TonFinancialPersistence } from "../persistence/TonFinancialPersistence.js";
import { RoomWalletOutboundIntentJournal } from "../payment/roomWallet/RoomWalletOutboundIntentJournal.js";
import { RoomWalletResidualSweepRepository } from "../payment/roomWallet/RoomWalletResidualSweepRepository.js";

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
