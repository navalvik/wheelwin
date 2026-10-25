import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TonFinancialPersistence } from "../persistence/TonFinancialPersistence.js";
import {
    RoomWalletOutboundIntentJournal
} from "../payment/roomWallet/RoomWalletOutboundIntentJournal.js";

const ROOM = "0:c6423c1a3f43921316bd31f66287ad437b94d0b9421340f622619c9fa80173a6";
const OLGA = "0:bdab0280cbbda45f5a0fb6bc97fa0e72e380769986440761d574901e269ae56b";
const LENA = "0:de5819f3012bf5bb3f0e502aa3a066ffcab5bf4d52dcf384b9b33a857e3907c8";
const BOB = "0:2d8205bb979c1f41c3f2cb7f18ee656e5e7874c111dca4528f21db426dc4476f";
const REFUND = {
    kind: "ROOM_WALLET_REFUND_OBLIGATION",
    state: "REFUND_RECONCILIATION_REQUIRED",
    status: "ACTIVE",
    network: "testnet",
    roomId: "oj7v",
    roomNumber: 1,
    gameId: "game_c2e30d65-2194-432f-8cc5-267d935e8fc4",
    paymentSessionId: "pay_cf9ef2f2-1026-4916-80f8-92392904a44a",
    fromRoomWallet: ROOM,
    grossRefundNano: "1000000000",
    executionAllowed: true
};
const GAS = 1388278n;
const NET = 1000000000n - GAS;
const SIGNED = "b".repeat(64);
const PLAN = "e".repeat(64);
const SOURCE_HASH = "decf4284978c28153475f4ac94668f77e233bed93d6aaf32f3ed9e737514565c";

function fx(t) {
    const dir = mkdtempSync(join(tmpdir(), "ww-outbound-intent-"));
    let active = null;
    function open() {
        active = new TonFinancialPersistence({ dataDir: dir });
        active.initialize();
        return {
            persistence: active,
            journal: new RoomWalletOutboundIntentJournal({ financialPersistence: active })
        };
    }
    t.after(() => {
        active?.shutdown({ checkpoint: false });
        rmSync(dir, { recursive: true, force: true });
    });
    function seed(persistence, { who = "Olga", addr = OLGA, suffix = "a" } = {}) {
        const id = "rwrefund_" + suffix.repeat(64);
        persistence.createRecoveryDataRecord({
            ...REFUND,
            recoveryRecordId: id,
            playerId: who,
            recipientWallet: addr
        }, { recoveryRecordId: id, status: "ACTIVE",
            roomId: REFUND.roomId, gameId: REFUND.gameId,
            tonNetwork: "testnet" });
        return id;
    }
    return { open, seed };
}

function create(journal, id, overrides = {}) {
    return journal.createRefundPlan({
        obligationId: id,
        netRefundNano: NET.toString(),
        recipientGasChargeNano: GAS.toString(),
        frozenGasPlanHash: PLAN,
        ...overrides
    });
}
function hold(journal, intentId, overrides = {}) {
    return journal.holdSignedMessage({
        intentId, seqno: 42, signedExternalMessageHash: SIGNED,
        validUntil: 1792901000, ...overrides
    });
}
function proof(to = OLGA, value = NET.toString(), other = {}) {
    return {
        confirmed: true, state: "CHAIN_CONFIRMED",
        receipt: {
            account: ROOM,
            recipient: to,
            valueNano: value,
            signedExternalMessageHash: SIGNED,
            roomWalletTxHash: SOURCE_HASH,
            roomWalletTxLt: "105271924000001",
            outboundMessageHash: "f".repeat(64),
            ...other
        }
    };
}

test("plan only from authoritative persisted pre-Page5 refund evidence", t => {
    const f = fx(t), { persistence, journal } = f.open();
    const id = f.seed(persistence);
    const created = create(journal, id);
    assert.equal(created.created, true);
    const recorded = journal.load(created.intentId);
    assert.equal(recorded.payload.network, "testnet");
    assert.equal(recorded.payload.role, "REFUND");
    assert.equal(recorded.payload.roomWallet, ROOM);
    assert.equal(recorded.payload.destinationWallet, OLGA);
    assert.equal(recorded.payload.transferNano, NET.toString());
    assert.equal(recorded.payload.gasChargeNano, GAS.toString());
    assert.equal(recorded.payload.signedExternalMessageHash, null);
    assert.equal(recorded.payload.broadcastingEnabled, false);
    assert.equal(typeof journal.sendTransfer, "undefined");
    assert.equal(typeof journal.broadcast, "undefined");
});

test("same immutable refund plan replays idempotently; changed value cannot rewrite it", t => {
    const f = fx(t), { persistence, journal } = f.open();
    const id = f.seed(persistence);
    const first = create(journal, id);
    assert.equal(create(journal, id).created, false);
    assert.throws(() => create(journal, id, {
        netRefundNano: (NET - 1n).toString(),
        recipientGasChargeNano: (GAS + 1n).toString()
    }), err => err.code === "OUTBOUND_INTENT_PLAN_CONFLICT");
    assert.equal(journal.load(first.intentId).payload.transferNano, NET.toString());
});

test("refuses arbitrary refund destinations, missing evidence and invalid gas budget", t => {
    const f = fx(t), { persistence, journal } = f.open();
    assert.throws(() => create(journal, "rwrefund_" + "9".repeat(64)));
    const id = f.seed(persistence);
    assert.throws(() => create(journal, id, { netRefundNano: "1000000000" }),
        err => err.code === "OUTBOUND_RECIPIENT_GAS_MISMATCH");
    assert.throws(() => create(journal, id, { frozenGasPlanHash: "invalid" }),
        err => err.code === "OUTBOUND_EXTERNAL_HASH_INVALID");
});

test("signed external intent is durably held before transport, cannot be overwritten", t => {
    const f = fx(t), { persistence, journal } = f.open();
    const id = create(journal, f.seed(persistence)).intentId;
    const ready = hold(journal, id);
    assert.equal(ready.state, "SIGNED_HELD");
    assert.equal(ready.broadcastAuthorized, false);
    assert.equal(journal.hasUnresolvedSignedAttempt(ROOM), true);
    assert.throws(() => hold(journal, id, { seqno: 43 }),
        err => err.code === "OUTBOUND_INTENT_ALREADY_ATTEMPTED");
    assert.equal(journal.load(id).payload.seqno, 42);
    assert.equal(journal.load(id).payload.signedExternalMessageHash, SIGNED);
});

test("second player cannot acquire same wallet while prior external message is unresolved", t => {
    const f = fx(t), { persistence, journal } = f.open();
    const first = create(journal, f.seed(persistence)).intentId;
    const second = create(journal, f.seed(persistence, {
        who: "Lena", addr: LENA, suffix: "c"
    })).intentId;
    const third = create(journal, f.seed(persistence, {
        who: "Bob", addr: BOB, suffix: "d"
    })).intentId;
    hold(journal, first);
    assert.throws(() => hold(journal, second, { seqno: 43 }),
        err => err.code === "OUTBOUND_WALLET_ALREADY_HELD");
    assert.throws(() => hold(journal, third, { seqno: 43 }),
        err => err.code === "OUTBOUND_WALLET_ALREADY_HELD");
    assert.equal(journal.listPendingForWallet(ROOM).length, 3);
    assert.equal(journal.hasUnresolvedSignedAttempt(ROOM), true);
});

test("network ambiguous reply stays held and survives process restart", t => {
    const f = fx(t), first = f.open();
    const id = create(first.journal, f.seed(first.persistence)).intentId;
    hold(first.journal, id);
    assert.equal(first.journal.markConfirmationUnknown(id).changed, true);
    assert.equal(first.journal.markConfirmationUnknown(id).changed, false);
    first.persistence.shutdown({ checkpoint: false });
    const recovered = f.open();
    assert.equal(recovered.journal.load(id).payload.state, "CONFIRMATION_UNKNOWN");
    assert.equal(recovered.journal.hasUnresolvedSignedAttempt(ROOM), true);
    assert.equal(recovered.journal.load(id).payload.signedExternalMessageHash, SIGNED);
    assert.throws(() => hold(recovered.journal, id, { seqno: 43 }),
        err => err.code === "OUTBOUND_INTENT_ALREADY_ATTEMPTED");
});

test("chain proof validates exact signed intent, destination, value and advanced seqno", t => {
    const f = fx(t), { persistence, journal } = f.open();
    const id = create(journal, f.seed(persistence)).intentId;
    hold(journal, id);
    assert.throws(() => journal.confirmWithChainProof({
        intentId: id, evidence: proof(), observedSeqno: 42
    }), err => err.code === "OUTBOUND_SEQNO_NOT_ADVANCED");
    assert.throws(() => journal.confirmWithChainProof({
        intentId: id, evidence: proof(BOB), observedSeqno: 43
    }), err => err.code === "OUTBOUND_PROOF_INTENT_MISMATCH");
    assert.throws(() => journal.confirmWithChainProof({
        intentId: id, evidence: proof(OLGA, NET.toString(), {
            signedExternalMessageHash: "c".repeat(64)
        }), observedSeqno: 43
    }), err => err.code === "OUTBOUND_PROOF_INTENT_MISMATCH");
    const result = journal.confirmWithChainProof({
        intentId: id, evidence: proof(), observedSeqno: 43
    });
    assert.equal(result.changed, true);
    assert.equal(journal.load(id).status, "SETTLED");
    assert.equal(journal.load(id).payload.state, "CHAIN_CONFIRMED");
    assert.equal(journal.hasUnresolvedSignedAttempt(ROOM), false);
    assert.equal(journal.confirmWithChainProof({ intentId: id }).changed, false);
    assert.equal(journal.load(id).payload.chainReceipt.walletTxHash, SOURCE_HASH);
});

test("different player may hold wallet only after prior transfer is CHAIN_CONFIRMED", t => {
    const f = fx(t), { persistence, journal } = f.open();
    const first = create(journal, f.seed(persistence)).intentId;
    const second = create(journal, f.seed(persistence, {
        who: "Lena", addr: LENA, suffix: "c"
    })).intentId;
    hold(journal, first);
    journal.confirmWithChainProof({ intentId: first, evidence: proof(), observedSeqno: 43 });
    assert.equal(hold(journal, second, { seqno: 43 }).state, "SIGNED_HELD");
});

test("payment intent never releases quarantined Room Wallet or creates a broadcast", t => {
    const f = fx(t), { persistence, journal } = f.open();
    const id = create(journal, f.seed(persistence)).intentId;
    assert.equal(typeof journal.releaseWallet, "undefined");
    assert.equal(typeof journal.sign, "undefined");
    assert.equal(typeof journal.broadcast, "undefined");
    assert.equal(journal.load(id).payload.broadcastingEnabled, false);
});
