import test from "node:test";
import assert from "node:assert/strict";

import {
    buildExpiredRoomWalletRefundObligations,
    RoomWalletRefundReconciliationError
} from "../payment/roomWallet/RoomWalletExpiredRefundObligations.js";

const ROOM = "EQDGQjwaP0OSExa9MfZih61De5TQuUITQPYiYZyfqAFzpvQB";
const PLAYERS = [
    { name: "Olga", playerId: "player_9847758d-8bf0-41ff-ab8f-59d4abb5ed38", wallet: "0QC9qwKAy72kX1oPtryX-g5y44B2mYZEB2HVdJAeJprlaxSR", raw: "0:bdab0280cbbda45f5a0fb6bc97fa0e72e380769986440761d574901e269ae56b", lt: "105264227000003", hash: "488351bef406163cf3fc0546e53d6472324e77b787a56a628f1e24c776d99ca3", time: 1792892552 },
    { name: "Lena", playerId: "player_bb8545e8-496b-4b22-8959-23e0835f6a7d", wallet: "0QDeWBnzASv1uz8OUCqjoGb_yrW_TVLc84S5szqFfjkHyMqm", raw: "0:de5819f3012bf5bb3f0e502aa3a066ffcab5bf4d52dcf384b9b33a857e3907c8", lt: "105264234000003", hash: "42e85d64a448206c739b0a953ca22ba0368409425c193ec0bfd4409aceaba72a", time: 1792892555 },
    { name: "Bob", playerId: "player_33088933-a1d4-405c-ab8f-94b14cb17025", wallet: "0QAtggW7l5wfQcPyy38Y7mVuXnh0wRHcpFKPIdtCbcRHbypD", raw: "0:2d8205bb979c1f41c3f2cb7f18ee656e5e7874c111dca4528f21db426dc4476f", lt: "105264240000003", hash: "a3692566ccc78cf87097af572aa573aaf6c0b460c8d11182c5a4850b8a68f5ef", time: 1792892557 }
];

const session = {
    paymentSessionId: "pay_cf9ef2f2-1026-4916-80f8-92392904a44a",
    roomId: "oj7v",
    roomNumber: 1,
    gameId: "game_c2e30d65-2194-432f-8cc5-267d935e8fc4",
    network: "testnet",
    roomWalletAddress: ROOM,
    createdAt: 1792892541339,
    paymentDeadline: 1792893021339,
    status: "WAITING_FOR_PAYMENTS",
    receivedPayments: [],
    participants: PLAYERS.map(p => ({
        playerId: p.playerId,
        wallet: p.wallet,
        requiredGram: 1,
        status: "BLOCKCHAIN_PENDING",
        refunded: false
    }))
};

const ROOM_RAW = "0:c6423c1a3f43921316bd31f66287ad437b94d0b9421340f622619c9fa80173a6";
const makeTx = (p, value = "1000000000") => ({
    success: true,
    transaction_id: { lt: p.lt, hash: p.hash },
    utime: p.time,
    in_msg: { source: p.raw, destination: ROOM_RAW, value }
});
const evidence = (rows = PLAYERS.map(p => makeTx(p)), awaitingSecondProvider = 0) => ({
    source: "tonapi+toncenter-v3",
    transactions: rows,
    awaitingSecondProvider
});
const plan = (override = {}) => buildExpiredRoomWalletRefundObligations({
    session,
    chainEvidence: evidence(),
    gameReachedPage5: false,
    historyComplete: true,
    ...override
});

test("oj7v: creates three obligations although historical session receivedPayments is empty", () => {
    const result = plan();
    assert.equal(session.receivedPayments.length, 0);
    assert.equal(result.obligations.length, 3);
    assert.equal(result.roomId, "oj7v");
    assert.equal(result.quarantineRequired, true);
    assert.equal(result.completedHistory, true);
    for (let i = 0; i < 3; i++) {
        const entry = result.obligations[i];
        assert.equal(entry.playerId, PLAYERS[i].playerId);
        assert.equal(entry.recipientWallet, PLAYERS[i].raw);
        assert.equal(entry.inboundTxHash, PLAYERS[i].hash);
        assert.equal(entry.grossRefundNano, "1000000000");
        assert.equal(entry.executionAllowed, true);
        assert.equal(entry.state, "REFUND_RECONCILIATION_REQUIRED");
    }
});

test("repeated recovery yields identical immutable IDs", () => {
    const a = plan(), b = plan();
    assert.deepEqual(
        a.obligations.map(x => x.obligationId),
        b.obligations.map(x => x.obligationId)
    );
    assert.ok(a.obligations.every(x => Object.isFrozen(x)));
});

test("a flag claiming refund already happened never substitutes for on-chain confirmation", () => {
    const source = { ...session, participants: session.participants.map(p => ({ ...p, refunded: true })) };
    const result = plan({ session: source });
    assert.equal(result.obligations.length, 3);
});

test("when Page5 ownership is unproven, refuse to declare refunds", () => {
    assert.throws(() => plan({ gameReachedPage5: true }), (err) => err.code === "PAGE5_OWNERSHIP_NOT_EXCLUDED");
    assert.throws(() => plan({ gameReachedPage5: null }), (err) => err.code === "PAGE5_OWNERSHIP_NOT_EXCLUDED");
});

test("missing second-source history remains quarantined even with zero matches", () => {
    const out = plan({
        chainEvidence: evidence([], 3),
        historyComplete: false
    });
    assert.equal(out.obligations.length, 0);
    assert.equal(out.quarantineRequired, true);
    assert.equal(out.completedHistory, false);
});

test("no matched deposits does not clear quarantine without complete historical proof", () => {
    assert.equal(plan({ chainEvidence: evidence([]), historyComplete: false }).quarantineRequired, true);
    assert.equal(plan({ chainEvidence: evidence([]), historyComplete: true }).quarantineRequired, false);
});

test("never auto-execute a mismatched amount; preserve returned-funds obligation", () => {
    const different = evidence([makeTx(PLAYERS[0], "500000000")]);
    const out = plan({ chainEvidence: different });
    assert.equal(out.obligations.length, 1);
    assert.equal(out.obligations[0].grossRefundNano, "500000000");
    assert.equal(out.obligations[0].executionAllowed, false);
    assert.equal(out.manualReview[0].code, "UNEXPECTED_PAYMENT_AMOUNT");
});

test("duplicate on-chain receipt fails closed rather than creating two obligations", () => {
    const tx = makeTx(PLAYERS[0]);
    assert.throws(
        () => plan({ chainEvidence: evidence([tx, tx]) }),
        (err) => err instanceof RoomWalletRefundReconciliationError
            && err.code === "DUPLICATE_INBOUND_RECEIPT"
    );
});

test("payments predating the session or well after expiry are not attributed silently", () => {
    const old = { ...makeTx(PLAYERS[0]), utime: 1792890000 };
    const later = { ...makeTx(PLAYERS[1]), utime: 1792899000 };
    assert.equal(plan({ chainEvidence: evidence([old, later]) }).obligations.length, 0);
});

test("zero-value and failed deposits are never refund-executable evidence", () => {
    const zero = makeTx(PLAYERS[0], "0");
    const failed = { ...makeTx(PLAYERS[1]), success: false };
    const out = plan({ chainEvidence: evidence([zero, failed]) });
    assert.equal(out.obligations.length, 0);
    assert.equal(out.manualReview[0].code, "UNPARSABLE_INBOUND_EVIDENCE");
});

test("invalid payment session, unknown network and unverified source fail closed", () => {
    assert.throws(
        () => plan({ session: { ...session, network: "mainnet" } }),
        (err) => err.code === "INVALID_PAYMENT_SESSION"
    );
    assert.throws(
        () => plan({ chainEvidence: { source: "single-provider", transactions: [] } }),
        (err) => err.code === "CHAIN_EVIDENCE_UNAVAILABLE"
    );
});
