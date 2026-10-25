import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TonFinancialPersistence } from "../persistence/TonFinancialPersistence.js";
import { RoomWalletOutboundIntentJournal } from "../payment/roomWallet/RoomWalletOutboundIntentJournal.js";

const ROOM = "0:c6423c1a3f43921316bd31f66287ad437b94d0b9421340f622619c9fa80173a6";
const WINNER = "0:de5819f3012bf5bb3f0e502aa3a066ffcab5bf4d52dcf384b9b33a857e3907c8";
const OWNER = "0:bdab0280cbbda45f5a0fb6bc97fa0e72e380769986440761d574901e269ae56b";
const fee = Object.freeze({
    inFwdFeeNano: "101068",
    storageFeeNano: "2",
    gasFeeNano: "220534",
    fwdFeeNano: "66667",
    totalNano: "388271"
});
const plan = () => ({
    mode: "RECIPIENT_PAYS_GAS",
    gasPolicyVersion: 1,
    feeSource: "estimateExternalMessageFee",
    marginBps: "2000",
    marginFloorNano: "1000000",
    winner: {
        role: "WINNER",
        destination: WINNER,
        grossPayoutNano: "2850000000",
        recipientGasChargeNano: "1388271",
        recipientTransferAmountNano: "2848611729",
        feeEvidence: { ...fee }
    },
    owner: {
        role: "OWNER",
        destination: OWNER,
        ownerGrossNano: "150000000",
        ownerRetainedNano: "10000000",
        ownerShareAfterRetentionNano: "140000000",
        grossPayoutNano: "140000000",
        recipientGasChargeNano: "1388271",
        recipientTransferAmountNano: "138611729",
        feeEvidence: { ...fee }
    }
});
const session = (overrides = {}) => ({
    settlementSessionId: "settle_test_oct07",
    roomId: "CEzQ",
    gameId: "game_successful_2026_10_07",
    network: "testnet",
    status: "SETTLEMENT_PENDING",
    winnerWallet: WINNER,
    ownerWallet: OWNER,
    prizeAmount: 2.85,
    organizerAmount: 0.15,
    request: {
        roomNumber: 1,
        roomId: "CEzQ",
        gameId: "game_successful_2026_10_07",
        winnerWallet: WINNER,
        ownerWallet: OWNER,
        payoutPlan: plan()
    },
    ...overrides
});

function fixture(t) {
    const dir = mkdtempSync(join(tmpdir(), "ww-owner-winner-intent-"));
    let store;
    const open = () => {
        store = new TonFinancialPersistence({ dataDir: dir });
        store.initialize();
        const journal = new RoomWalletOutboundIntentJournal({
            financialPersistence: store,
            roomWalletRegistry: {
                get(roomNumber) {
                    return roomNumber === 1 ? { roomNumber, address: ROOM } : null;
                }
            }
        });
        return { store, journal };
    };
    t.after(() => {
        store?.shutdown({ checkpoint: false });
        rmSync(dir, { recursive: true, force: true });
    });
    const create = (s = session()) => {
        const current = open();
        current.store.createSettlementRecord(s, {
            gameId: s.gameId,
            roomId: s.roomId,
            tonNetwork: s.network,
            status: s.status
        });
        return current;
    };
    return { create, open };
}

test("historic 2.85/0.15 payout plan freezes winner and owner transfers separately", t => {
    const { journal } = fixture(t).create();
    const winner = journal.createSettlementPlan({
        gameId: session().gameId, role: "WINNER"
    });
    const owner = journal.createSettlementPlan({
        gameId: session().gameId, role: "OWNER"
    });
    assert.equal(winner.created, true);
    assert.equal(owner.created, true);
    assert.notEqual(winner.intentId, owner.intentId);
    const w = journal.load(winner.intentId).payload;
    const o = journal.load(owner.intentId).payload;
    assert.equal(w.destinationWallet, WINNER);
    assert.equal(w.grossNano, "2850000000");
    assert.equal(w.gasChargeNano, "1388271");
    assert.equal(w.transferNano, "2848611729");
    assert.equal(o.destinationWallet, OWNER);
    assert.equal(o.grossNano, "140000000");
    assert.equal(o.gasChargeNano, "1388271");
    assert.equal(o.transferNano, "138611729");
    assert.equal(w.roomWallet, ROOM);
    assert.equal(w.frozenGasPlanHash, o.frozenGasPlanHash);
    assert.equal(w.broadcastingEnabled, false);
    assert.equal(journal.listPendingForWallet(ROOM).length, 2);
});

test("owner cannot receive payout while winner external message unresolved", t => {
    const { journal } = fixture(t).create();
    const winner = journal.createSettlementPlan({
        gameId: session().gameId, role: "WINNER"
    });
    const owner = journal.createSettlementPlan({
        gameId: session().gameId, role: "OWNER"
    });
    journal.holdSignedMessage({
        intentId: winner.intentId, seqno: 12,
        signedExternalMessageHash: "a".repeat(64), validUntil: 1800000000
    });
    assert.throws(() => journal.holdSignedMessage({
        intentId: owner.intentId, seqno: 13,
        signedExternalMessageHash: "b".repeat(64), validUntil: 1800000000
    }), e => e.code === "OUTBOUND_WALLET_ALREADY_HELD");
});

test("payout plan cannot be synthesized if no frozen source record exists", t => {
    const broken = session({ request: { ...session().request, payoutPlan: null } });
    const { journal } = fixture(t).create(broken);
    assert.throws(() => journal.createSettlementPlan({
        gameId: broken.gameId, role: "WINNER"
    }), e => e.code === "OUTBOUND_SETTLEMENT_FROZEN_PLAN_REQUIRED");
});

test("incorrect winner gross amount causes the plan to fail closed", t => {
    const altered = session({ prizeAmount: 2.86 });
    const { journal } = fixture(t).create(altered);
    assert.throws(() => journal.createSettlementPlan({
        gameId: altered.gameId, role: "WINNER"
    }), e => e.code === "OUTBOUND_SETTLEMENT_FROZEN_PLAN_INVALID");
});

test("owner retention cannot be changed or omitted", t => {
    const broken = plan();
    broken.owner.ownerRetainedNano = "0";
    const s = session({ request: { ...session().request, payoutPlan: broken } });
    const { journal } = fixture(t).create(s);
    assert.throws(() => journal.createSettlementPlan({
        gameId: s.gameId, role: "OWNER"
    }), e => e.code === "OUTBOUND_SETTLEMENT_RETENTION_INVALID");
});

test("Mainnet cannot create Testnet payment intents", t => {
    const s = session({ network: "mainnet" });
    const { journal } = fixture(t).create(s);
    assert.throws(() => journal.createSettlementPlan({
        gameId: s.gameId, role: "WINNER"
    }), e => e.code === "OUTBOUND_SETTLEMENT_FROZEN_PLAN_REQUIRED");
});

test("settlement plans replay identically after restart without duplicate intents", t => {
    const f = fixture(t), first = f.create();
    const id = first.journal.createSettlementPlan({
        gameId: session().gameId, role: "OWNER"
    }).intentId;
    first.store.shutdown({ checkpoint: false });
    const next = f.open();
    const repeat = next.journal.createSettlementPlan({
        gameId: session().gameId, role: "OWNER"
    });
    assert.equal(repeat.created, false);
    assert.equal(repeat.intentId, id);
});

test("frozen destination cannot change on settlement retry", t => {
    const f = fixture(t), current = f.create();
    current.journal.createSettlementPlan({
        gameId: session().gameId, role: "WINNER"
    });
    const record = current.store.loadSettlementRecord(session().gameId);
    const changed = {
        ...record.payload,
        request: {
            ...record.payload.request,
            payoutPlan: {
                ...record.payload.request.payoutPlan,
                winner: { ...record.payload.request.payoutPlan.winner, destination: OWNER }
            }
        }
    };
    current.store.updateSettlementRecord(session().gameId, changed, { status: "SETTLEMENT_PENDING" });
    assert.throws(() => current.journal.createSettlementPlan({
        gameId: session().gameId, role: "WINNER"
    }), e => e.code === "OUTBOUND_SETTLEMENT_FROZEN_PLAN_INVALID");
});
