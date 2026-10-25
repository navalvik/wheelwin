import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TonFinancialPersistence } from "../persistence/TonFinancialPersistence.js";
import { RoomWalletRefundRecoveryRepository } from "../payment/roomWallet/RoomWalletRefundRecoveryRepository.js";
import { RoomWalletOutboundIntentJournal } from "../payment/roomWallet/RoomWalletOutboundIntentJournal.js";
import { RoomWalletQuarantineReleaseGuard } from "../payment/roomWallet/RoomWalletQuarantineReleaseGuard.js";
import { buildExpiredRoomWalletRefundObligations } from "../payment/roomWallet/RoomWalletExpiredRefundObligations.js";

const ROOM = "0:c6423c1a3f43921316bd31f66287ad437b94d0b9421340f622619c9fa80173a6";
const PEOPLE = [
    ["Olga", "0:bdab0280cbbda45f5a0fb6bc97fa0e72e380769986440761d574901e269ae56b"],
    ["Lena", "0:de5819f3012bf5bb3f0e502aa3a066ffcab5bf4d52dcf384b9b33a857e3907c8"],
    ["Bob", "0:2d8205bb979c1f41c3f2cb7f18ee656e5e7874c111dca4528f21db426dc4476f"]
];
const HEAD = "f".repeat(64);
const NOW = Date.now();
const START = NOW - 60 * 60 * 1000;
const DEADLINE = START + 5 * 60 * 1000;

function fixture(t) {
    const dir = mkdtempSync(join(tmpdir(), "wheelwin-quarantine-release-"));
    let active = null;
    const session = {
        roomId: "room_1", roomNumber: 1, gameId: "game_1",
        paymentSessionId: "pay_1", network: "testnet",
        roomWalletAddress: ROOM,
        createdAt: START, paymentDeadline: DEADLINE,
        participants: PEOPLE.map(([playerId, wallet]) => ({
            playerId, wallet, requiredAmountNano: "1000000000"
        }))
    };
    function open() {
        const db = new TonFinancialPersistence({ dataDir: dir });
        db.initialize();
        const repo = new RoomWalletRefundRecoveryRepository({ financialPersistence: db });
        const journal = new RoomWalletOutboundIntentJournal({ financialPersistence: db });
        active = { db, repo, journal };
        return active;
    }
    t.after(() => {
        active?.db.shutdown({ checkpoint: false });
        rmSync(dir, { force: true, recursive: true });
    });
    const f = open();
    f.db.createPaymentSession(session, {
        paymentSessionId: session.paymentSessionId,
        roomId: session.roomId, gameId: session.gameId, tonNetwork: "testnet"
    });
    const hold = f.repo.beginQuarantine({
        roomId: session.roomId, gameId: session.gameId,
        paymentSessionId: session.paymentSessionId, roomNumber: 1,
        roomWallet: ROOM
    });
    const evidence = {
        source: "tonapi+toncenter-v3",
        historyComplete: true,
        rawAddress: ROOM,
        awaitingSecondProvider: 0,
        accountTip: { lt: "42", hash: HEAD },
        transactions: []
    };
    let at = NOW + 20 * 60 * 1000;
    let activeRoom = false;
    let sweepRecords = [];
    const scanner = async () => evidence;
    const headReader = async () => ({
        roomWallet: ROOM, headLt: evidence.accountTip.lt,
        headHash: evidence.accountTip.hash, providersAgree: true
    });
    function guard(ctx = f, overrides = {}) {
        return new RoomWalletQuarantineReleaseGuard({
            repository: ctx.repo,
            financialPersistence: ctx.db,
            residualSweepRepository: { listActive: () => sweepRecords },
            historyScanner: overrides.historyScanner ?? scanner,
            accountTipReader: overrides.accountTipReader ?? headReader,
            isRoomActive: overrides.isRoomActive ?? (() => activeRoom),
            now: () => at
        });
    }
    return {
        ...f, open, session, hold, evidence, guard,
        setNow(value) { at = value; },
        setActive(value) { activeRoom = value; },
        setSweeps(value) { sweepRecords = value; }
    };
}

test("quarantined expired room with ZERO deposits re-enters wallet pool after head proof", async t => {
    const f = fixture(t);
    assert.equal(f.repo.isRoomNumberQuarantined(1), true);
    const result = await f.guard().tryRelease({ recordId: f.hold.recordId });
    assert.equal(result.changed, true);
    assert.equal(result.unblocked, true);
    assert.equal(f.repo.isRoomNumberQuarantined(1), false);
    const persisted = f.db.loadRecoveryDataRecord(f.hold.recordId);
    assert.equal(persisted.status, "SETTLED");
    assert.equal(persisted.payload.state, "CHAIN_RECONCILED_CLOSED");
    assert.equal(persisted.payload.chainClosure.headHash, HEAD);
    f.db.shutdown({ checkpoint: false });
    const restarted = f.open();
    assert.equal(restarted.repo.isRoomNumberQuarantined(1), false);
});

test("quiet-window, active room and unmatched account heads always retain quarantine", async t => {
    const f = fixture(t);
    f.setNow(NOW + 3 * 60 * 1000);
    await assert.rejects(
        f.guard().tryRelease({ recordId: f.hold.recordId }),
        e => e.code === "QUARANTINE_RELEASE_QUIET_WINDOW_NOT_ELAPSED"
    );
    f.setNow(NOW + 20 * 60 * 1000);
    f.setActive(true);
    await assert.rejects(
        f.guard().tryRelease({ recordId: f.hold.recordId }),
        e => e.code === "QUARANTINE_RELEASE_ROOM_STILL_ACTIVE"
    );
    f.setActive(false);
    await assert.rejects(
        f.guard(f, { accountTipReader: async () => ({
            roomWallet: ROOM, headLt: "43",
            headHash: "a".repeat(64), providersAgree: true
        }) }).tryRelease({ recordId: f.hold.recordId }),
        e => e.code === "QUARANTINE_RELEASE_INDEXER_HEAD_NOT_FRESH"
    );
    assert.equal(f.repo.isRoomNumberQuarantined(1), true);
});

test("unknown residual sweep or pending payout prevents wallet reallocation", async t => {
    const f = fixture(t);
    f.setSweeps([{
        payload: { roomNumber: 1, status: "FAILED_RETRY" }
    }]);
    await assert.rejects(
        f.guard().tryRelease({ recordId: f.hold.recordId }),
        e => e.code === "QUARANTINE_RELEASE_RESIDUAL_SWEEP_PENDING"
    );
    f.setSweeps([]);
    const id = "rwout_" + "9".repeat(64);
    f.db.createRecoveryDataRecord({
        recoveryRecordId: id,
        kind: "ROOM_WALLET_OUTBOUND_INTENT",
        status: "ACTIVE", state: "CONFIRMATION_UNKNOWN",
        roomWallet: ROOM
    }, {
        recoveryRecordId: id, status: "ACTIVE",
        roomId: "some-other-room", gameId: "other-game",
        tonNetwork: "testnet"
    });
    await assert.rejects(
        f.guard().tryRelease({ recordId: f.hold.recordId }),
        e => e.code === "QUARANTINE_RELEASE_OUTBOUND_INTENT_UNRESOLVED"
    );
});

test("actual paid player leaves wallet quarantined until refund CHAIN_CONFIRMED", async t => {
    const f = fixture(t);
    const [playerId, sender] = PEOPLE[0];
    const incoming = {
        success: true, utime: Math.floor((START + 20_000) / 1000),
        lt: "84", hash: "a".repeat(64),
        in_msg: { source: sender, destination: ROOM, value: "1000000000" },
        out_msgs: []
    };
    const output = {
        success: true, utime: Math.floor((DEADLINE + 60_000) / 1000),
        lt: "85", hash: "b".repeat(64),
        in_msg: { source: null, destination: ROOM, value: "0" },
        out_msgs: [{ destination: sender, value: "998611722" }]
    };
    f.evidence.transactions = [output, incoming];
    f.evidence.accountTip = { lt: "85", hash: "b".repeat(64) };
    const plan = buildExpiredRoomWalletRefundObligations({
        session: f.session, chainEvidence: f.evidence,
        gameReachedPage5: false, historyComplete: true
    });
    assert.equal(plan.obligations.length, 1);
    f.repo.persistReconciliation({
        plan, session: f.session, gameReachedPage5: false
    });
    await assert.rejects(
        f.guard().tryRelease({ recordId: f.hold.recordId }),
        e => e.code === "QUARANTINE_RELEASE_REFUND_UNPAID"
    );
    const intent = f.journal.createRefundPlan({
        obligationId: plan.obligations[0].obligationId,
        netRefundNano: "998611722",
        recipientGasChargeNano: "1388278",
        frozenGasPlanHash: "e".repeat(64)
    });
    f.journal.holdSignedMessage({
        intentId: intent.intentId, seqno: 41,
        signedExternalMessageHash: "c".repeat(64),
        validUntil: Math.floor(DEADLINE / 1000) + 360
    });
    await assert.rejects(
        f.guard().tryRelease({ recordId: f.hold.recordId }),
        e => e.code === "QUARANTINE_RELEASE_OUTBOUND_INTENT_UNRESOLVED"
    );
    f.journal.confirmWithChainProof({
        intentId: intent.intentId, observedSeqno: 42,
        evidence: {
            confirmed: true, state: "CHAIN_CONFIRMED",
            receipt: {
                account: ROOM, recipient: sender,
                valueNano: "998611722", signedExternalMessageHash: "c".repeat(64),
                roomWalletTxHash: "b".repeat(64), roomWalletTxLt: "85",
                outboundMessageHash: "d".repeat(64)
            }
        }
    });
    const done = await f.guard().tryRelease({ recordId: f.hold.recordId });
    assert.equal(done.unblocked, true);
    assert.equal(f.repo.isRoomNumberQuarantined(1), false);
});

test("one extra unrecognized player deposit blocks release even without recorded debt", async t => {
    const f = fixture(t);
    f.evidence.transactions = [{
        success: true, utime: Math.floor((START + 20_000) / 1000),
        lt: "84", hash: "a".repeat(64),
        in_msg: {
            source: "0:" + "4".repeat(64), destination: ROOM,
            value: "1000000000"
        }
    }];
    f.evidence.accountTip = { lt: "84", hash: "a".repeat(64) };
    await assert.rejects(
        f.guard().tryRelease({ recordId: f.hold.recordId }),
        e => e.code === "QUARANTINE_RELEASE_UNTRACKED_INCOMING"
    );
});


test("repeated teardown callback cannot re-quarantine an already chain-closed wallet", async t => {
    const f = fixture(t);
    await f.guard().tryRelease({ recordId: f.hold.recordId });
    const again = f.repo.beginQuarantine({
        roomId: f.session.roomId, gameId: f.session.gameId,
        paymentSessionId: f.session.paymentSessionId,
        roomNumber: 1, roomWallet: ROOM
    });
    assert.equal(again.created, false);
    assert.equal(f.repo.isRoomNumberQuarantined(1), false);
});

test("closing one marker does not release another open marker with the same room number", async t => {
    const f = fixture(t);
    f.repo.beginSettlementQuarantine({
        roomId: "other_room", gameId: "other_game",
        roomNumber: 1, roomWallet: ROOM
    });
    const closed = await f.guard().tryRelease({ recordId: f.hold.recordId });
    assert.equal(closed.changed, true);
    assert.equal(closed.unblocked, false);
    assert.equal(f.repo.isRoomNumberQuarantined(1), true);
    assert.equal(f.repo.listOpenSettlementQuarantines().length, 1);
});

test("post-Page5 wallet remains quarantined until BOTH authoritative payouts finalize", async t => {
    const folder = mkdtempSync(join(tmpdir(), "ww-successful-game-quarantine-"));
    const db = new TonFinancialPersistence({ dataDir: folder });
    db.initialize();
    t.after(() => {
        db.shutdown({ checkpoint: false });
        rmSync(folder, { force: true, recursive: true });
    });
    const repo = new RoomWalletRefundRecoveryRepository({ financialPersistence: db });
    const winnerWallet = PEOPLE[1][1], ownerWallet = PEOPLE[0][1];
    const feeEvidence = {
        inFwdFeeNano: "101068", storageFeeNano: "2",
        gasFeeNano: "220534", fwdFeeNano: "66667", totalNano: "388271"
    };
    const plan = {
        mode: "RECIPIENT_PAYS_GAS",
        gasPolicyVersion: 1,
        feeSource: "estimateExternalMessageFee",
        marginBps: "2000", marginFloorNano: "1000000",
        winner: {
            role: "WINNER", destination: winnerWallet,
            grossPayoutNano: "2850000000",
            recipientGasChargeNano: "1388271",
            recipientTransferAmountNano: "2848611729",
            feeEvidence
        },
        owner: {
            role: "OWNER", destination: ownerWallet,
            ownerGrossNano: "150000000",
            ownerRetainedNano: "10000000",
            ownerShareAfterRetentionNano: "140000000",
            grossPayoutNano: "140000000",
            recipientGasChargeNano: "1388271",
            recipientTransferAmountNano: "138611729",
            feeEvidence
        }
    };
    const payment = {
        roomId: "page5_room", gameId: "page5_game",
        paymentSessionId: "page5_pay", roomNumber: 1,
        network: "testnet", roomWalletAddress: ROOM,
        createdAt: START, paymentDeadline: DEADLINE,
        participants: PEOPLE.map(([playerId, wallet]) => ({
            playerId, wallet, requiredAmountNano: "1000000000"
        }))
    };
    db.createPaymentSession(payment, {
        paymentSessionId: payment.paymentSessionId,
        gameId: payment.gameId,
        roomId: payment.roomId, tonNetwork: "testnet"
    });
    const settlement = {
        settlementSessionId: "page5_settlement",
        gameId: payment.gameId, roomId: payment.roomId,
        status: "SETTLEMENT_COMPLETED",
        network: "testnet",
        winnerWallet, ownerWallet,
        prizeAmount: 2.85, organizerAmount: 0.15,
        request: {
            roomId: payment.roomId, roomNumber: 1,
            gameId: payment.gameId,
            winnerWallet, ownerWallet, payoutPlan: plan
        }
    };
    db.createSettlementRecord(settlement, {
        roomId: payment.roomId, gameId: payment.gameId,
        tonNetwork: "testnet", status: "SETTLEMENT_COMPLETED"
    });
    const marker = repo.beginSettlementQuarantine({
        roomId: payment.roomId, gameId: payment.gameId,
        roomNumber: 1, roomWallet: ROOM
    });
    const journal = new RoomWalletOutboundIntentJournal({
        financialPersistence: db,
        roomWalletRegistry: { get: num => num === 1 ? { address: ROOM } : null }
    });
    const chain = {
        source: "tonapi+toncenter-v3", rawAddress: ROOM,
        historyComplete: true, awaitingSecondProvider: 0,
        accountTip: { lt: "205", hash: "e".repeat(64) },
        transactions: [
            { success: true, lt: "205", hash: "e".repeat(64),
              utime: Math.floor((DEADLINE + 45_000) / 1000),
              in_msg: { destination: ROOM, source: null, value: "0" } },
            { success: true, lt: "204", hash: "d".repeat(64),
              utime: Math.floor((DEADLINE + 20_000) / 1000),
              in_msg: { destination: ROOM, source: null, value: "0" } },
            ...PEOPLE.slice().reverse().map(([playerId, wallet], i) => ({
                success: true, lt: String(203 - i),
                hash: String(i + 1).repeat(64),
                utime: Math.floor((START + 50_000 - i * 3_000) / 1000),
                in_msg: { destination: ROOM, source: wallet, value: "1000000000" }
            }))
        ]
    };
    const closer = new RoomWalletQuarantineReleaseGuard({
        repository: repo,
        financialPersistence: db,
        residualSweepRepository: { listActive: () => [] },
        historyScanner: async () => chain,
        accountTipReader: async () => ({
            roomWallet: ROOM, headLt: "205",
            headHash: "e".repeat(64), providersAgree: true
        }),
        isRoomActive: () => false,
        now: () => NOW + 20 * 60 * 1000
    });

    await assert.rejects(
        closer.tryRelease({ recordId: marker.recordId }),
        e => e.code === "QUARANTINE_RELEASE_SETTLEMENT_OUTBOUND_UNPAID"
    );
    function confirm(role, seqno) {
        const intent = journal.createSettlementPlan({
            gameId: payment.gameId, role
        });
        const payload = journal.load(intent.intentId).payload;
        journal.holdSignedMessage({
            intentId: intent.intentId,
            seqno, signedExternalMessageHash: String(seqno % 10).repeat(64),
            validUntil: Math.floor(DEADLINE / 1000) + 100
        });
        journal.confirmWithChainProof({
            intentId: intent.intentId, observedSeqno: seqno + 1,
            evidence: {
                confirmed: true, state: "CHAIN_CONFIRMED",
                receipt: {
                    account: ROOM, recipient: payload.destinationWallet,
                    valueNano: payload.transferNano,
                    signedExternalMessageHash: String(seqno % 10).repeat(64),
                    roomWalletTxHash: String((seqno + 1) % 10).repeat(64),
                    roomWalletTxLt: String(200 + seqno),
                    outboundMessageHash: "f".repeat(64)
                }
            }
        });
    }
    confirm("WINNER", 41);
    await assert.rejects(
        closer.tryRelease({ recordId: marker.recordId }),
        e => e.code === "QUARANTINE_RELEASE_SETTLEMENT_OUTBOUND_UNPAID"
    );
    confirm("OWNER", 42);
    const closed = await closer.tryRelease({ recordId: marker.recordId });
    assert.equal(closed.unblocked, true);
    assert.equal(repo.isRoomNumberQuarantined(1), false);
    assert.equal(db.loadRecoveryDataRecord(marker.recordId).payload.chainClosure.settledIntents.length, 2);
});


test("late transaction arriving after history read but before release keeps wallet held", async t => {
    const f = fixture(t);
    let checks = 0;
    const reader = async () => {
        checks++;
        return {
            roomWallet: ROOM,
            headLt: checks === 1 ? "42" : "43",
            headHash: checks === 1 ? HEAD : "a".repeat(64),
            providersAgree: true
        };
    };
    await assert.rejects(
        f.guard(f, { accountTipReader: reader })
            .tryRelease({ recordId: f.hold.recordId }),
        err => err.code === "QUARANTINE_RELEASE_HEAD_CHANGED_DURING_RECONCILIATION"
    );
    assert.equal(checks, 2);
    assert.equal(f.repo.isRoomNumberQuarantined(1), true);
    assert.equal(f.db.loadRecoveryDataRecord(f.hold.recordId).status, "ACTIVE");
});
