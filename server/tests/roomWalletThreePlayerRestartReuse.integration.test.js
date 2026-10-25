/**
 * Full offline, restart-sensitive Page4 -> destroyed room -> refund debt ->
 * chain-finality -> wallet reuse regression. This exercises the real durable
 * financial journal and real RoomManager allocation, but never sends GRAM.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RoomManager } from "../managers/RoomManager.js";
import { TonFinancialPersistence } from "../persistence/TonFinancialPersistence.js";
import { RoomWalletRefundRecoveryRepository } from "../payment/roomWallet/RoomWalletRefundRecoveryRepository.js";
import { RoomWalletOutboundIntentJournal } from "../payment/roomWallet/RoomWalletOutboundIntentJournal.js";
import { RoomWalletQuarantineReleaseGuard } from "../payment/roomWallet/RoomWalletQuarantineReleaseGuard.js";
import { buildExpiredRoomWalletRefundObligations } from "../payment/roomWallet/RoomWalletExpiredRefundObligations.js";

const ROOM = "0:c6423c1a3f43921316bd31f66287ad437b94d0b9421340f622619c9fa80173a6";
const PLAYERS = [
    ["Olga", "0:bdab0280cbbda45f5a0fb6bc97fa0e72e380769986440761d574901e269ae56b"],
    ["Lena", "0:de5819f3012bf5bb3f0e502aa3a066ffcab5bf4d52dcf384b9b33a857e3907c8"],
    ["Bob", "0:2d8205bb979c1f41c3f2cb7f18ee656e5e7874c111dca4528f21db426dc4476f"]
];
const NOW = Date.now(), START = NOW - 60 * 60 * 1000;
const EXPIRY = START + 5 * 60 * 1000;
const GROSS = "1000000000", NET = "998611722", GAS = "1388278";
const ROOM_ID = "room_three_payers", GAME_ID = "game_three_payers", PAY_ID = "pay_three_payers";
const logger = { info() {}, warn() {}, error() {}, decisionTrace() {} };
const bus = { emit() {}, subscribe() {}, unsubscribe() {} };

function manager(repo) {
    const m = new RoomManager({
        logger, eventBus: bus,
        roomConfig: { maxPlayers: 3, maxConcurrentRooms: 50 }
    });
    let counter = 0;
    m._generateRoomId = () => "round_" + (++counter);
    m.attachSetupSessionLifecycle({
        createForRoom() { return {}; },
        abortForRoom() { return true; }
    });
    m.attachRoomWalletAllocationGuard(repo);
    return m;
}

function proofData() {
    const incoming = PLAYERS.map(([playerId, address], i) => ({
        success: true,
        utime: Math.floor((START + 20_000 + i * 9_000) / 1000),
        lt: String(10 + i),
        hash: String(i + 1).repeat(64),
        in_msg: { source: address, destination: ROOM, value: GROSS },
        out_msgs: []
    }));
    const outgoing = PLAYERS.map(([playerId, address], i) => ({
        success: true,
        utime: Math.floor((EXPIRY + 60_000 + i * 10_000) / 1000),
        lt: String(20 + i),
        hash: String(i + 7).repeat(64),
        in_msg: { source: null, destination: ROOM, value: "0" },
        out_msgs: [{ destination: address, value: NET, hash: String(i + 4).repeat(64) }]
    }));
    const transactions = [...outgoing.reverse(), ...incoming.reverse()];
    return {
        source: "tonapi+toncenter-v3",
        historyComplete: true,
        awaitingSecondProvider: 0,
        rawAddress: ROOM,
        accountTip: { lt: "22", hash: "9".repeat(64) },
        transactions
    };
}

function testWorld(t) {
    const dir = mkdtempSync(join(tmpdir(), "wheelwin-3payer-restart-"));
    let active;
    const session = {
        roomId: ROOM_ID, gameId: GAME_ID, paymentSessionId: PAY_ID,
        roomNumber: 1, network: "testnet", roomWalletAddress: ROOM,
        createdAt: START, paymentDeadline: EXPIRY,
        participants: PLAYERS.map(([playerId, wallet]) => ({
            playerId, wallet, requiredAmountNano: GROSS
        }))
    };
    const history = proofData();
    function open() {
        const db = new TonFinancialPersistence({ dataDir: dir });
        db.initialize();
        active = {
            db,
            repo: new RoomWalletRefundRecoveryRepository({ financialPersistence: db }),
            journal: new RoomWalletOutboundIntentJournal({ financialPersistence: db })
        };
        return active;
    }
    t.after(() => {
        active?.db?.shutdown({ checkpoint: false });
        rmSync(dir, { recursive: true, force: true });
    });
    const state = open();
    state.db.createPaymentSession(session, {
        paymentSessionId: PAY_ID, roomId: ROOM_ID, gameId: GAME_ID, tonNetwork: "testnet"
    });
    const hold = state.repo.beginQuarantine({
        roomId: ROOM_ID, gameId: GAME_ID,
        paymentSessionId: PAY_ID, roomNumber: 1, roomWallet: ROOM
    });
    function restart() {
        active.db.shutdown({ checkpoint: false });
        return open();
    }
    function makeGuard(current = active, options = {}) {
        return new RoomWalletQuarantineReleaseGuard({
            repository: current.repo, financialPersistence: current.db,
            residualSweepRepository: { listActive: () => [] },
            historyScanner: async () => history,
            accountTipReader: async () => ({
                roomWallet: ROOM,
                headLt: history.accountTip.lt,
                headHash: history.accountTip.hash,
                providersAgree: options.headAgrees !== false
            }),
            isRoomActive: () => false,
            now: () => NOW + 20 * 60 * 1000
        });
    }
    function saveDebts(current = active) {
        const plan = buildExpiredRoomWalletRefundObligations({
            session, chainEvidence: history,
            gameReachedPage5: false,
            historyComplete: true
        });
        assert.equal(plan.obligations.length, 3);
        current.repo.persistReconciliation({ session, plan, gameReachedPage5: false });
        return plan;
    }
    function confirm(current, obligation, i) {
        const created = current.journal.createRefundPlan({
            obligationId: obligation.obligationId,
            netRefundNano: NET, recipientGasChargeNano: GAS,
            frozenGasPlanHash: "e".repeat(64)
        });
        if (current.journal.load(created.intentId).status === "SETTLED") return created;
        const seqno = 41 + i, signed = String(i + 4).repeat(64);
        current.journal.holdSignedMessage({
            intentId: created.intentId, seqno,
            signedExternalMessageHash: signed,
            validUntil: Math.floor(EXPIRY / 1000) + 120
        });
        current.journal.confirmWithChainProof({
            intentId: created.intentId, observedSeqno: seqno + 1,
            evidence: {
                confirmed: true, state: "CHAIN_CONFIRMED",
                receipt: {
                    account: ROOM, recipient: obligation.recipientWallet,
                    valueNano: NET,
                    signedExternalMessageHash: signed,
                    roomWalletTxHash: String(i + 7).repeat(64),
                    roomWalletTxLt: String(20 + i),
                    outboundMessageHash: String(i + 4).repeat(64)
                }
            }
        });
        return created;
    }
    return { state, session, history, hold, restart, saveDebts, confirm, makeGuard };
}

test("three paid players, uncertain refunds, crash, confirmed refunds, safe room number reuse", async t => {
    const f = testWorld(t);
    assert.equal(f.state.repo.isRoomNumberQuarantined(1), true);
    const plan = f.saveDebts();
    assert.equal(f.state.repo.listRefundObligations({ roomId: ROOM_ID }).length, 3);
    // 1/3 refunded and 2/3 pending: wallet 1 stays blocked for new rooms.
    f.confirm(f.state, plan.obligations[0], 0);
    let next = manager(f.state.repo);
    assert.equal(next.createRoom().roomNumber, 2);
    await assert.rejects(f.makeGuard(f.state).tryRelease({
        recordId: f.hold.recordId
    }), e => e.code === "QUARANTINE_RELEASE_REFUND_UNPAID");
    const reboot = f.restart();
    assert.equal(reboot.repo.isRoomNumberQuarantined(1), true);
    assert.equal(reboot.repo.listRefundObligations({ roomId: ROOM_ID }).length, 3);
    next = manager(reboot.repo);
    assert.equal(next.createRoom().roomNumber, 2);
    f.confirm(reboot, plan.obligations[1], 1);
    await assert.rejects(f.makeGuard(reboot).tryRelease({
        recordId: f.hold.recordId
    }), e => e.code === "QUARANTINE_RELEASE_REFUND_UNPAID");
    f.confirm(reboot, plan.obligations[2], 2);
    assert.equal(reboot.journal.listUnresolvedSignedIntents().length, 0);
    const closed = await f.makeGuard(reboot).tryRelease({ recordId: f.hold.recordId });
    assert.equal(closed.changed, true);
    assert.equal(closed.unblocked, true);
    assert.equal(reboot.repo.isRoomNumberQuarantined(1), false);
    assert.equal(reboot.db.loadRecoveryDataRecord(f.hold.recordId)
        .payload.chainClosure.settledIntents.length, 3);
    const afterClose = f.restart();
    assert.equal(afterClose.repo.listAllocationBlocks().length, 0);
    assert.equal(manager(afterClose.repo).createRoom().roomNumber, 1);
    // No duplicate liability or outgoing intent on a second call.
    assert.equal(afterClose.repo.listRefundObligations({ roomId: ROOM_ID }).length, 3);
});

test("50-room allocation remains safe with 14 holds and one re-certified wallet", async t => {
    const f = testWorld(t);
    f.saveDebts();
    const otherHolds = [];
    for (let number = 2; number <= 14; number++) {
        otherHolds.push(f.state.repo.beginQuarantine({
            roomId: "other" + number, roomNumber: number,
            gameId: "game" + number,
            paymentSessionId: "pay" + number,
            roomWallet: ROOM
        }));
    }
    const before = manager(f.state.repo);
    const allocations = Array.from({ length: 50 }, () => before.createRoom());
    assert.equal(allocations.filter(Boolean).length, 50);
    assert.equal(allocations[0].roomNumber, 15);
    assert.equal(before.createRoom(), null);
    const reboot = f.restart();
    const plan = buildExpiredRoomWalletRefundObligations({
        session: f.session, chainEvidence: f.history,
        gameReachedPage5: false, historyComplete: true
    });
    for (let i = 0; i < plan.obligations.length; i++) {
        f.confirm(reboot, plan.obligations[i], i);
    }
    const closed = await f.makeGuard(reboot).tryRelease({ recordId: f.hold.recordId });
    assert.equal(closed.unblocked, true);
    assert.equal(reboot.repo.listAllocationBlocks().length, 13);
    const after = manager(reboot.repo);
    const all = Array.from({ length: 50 }, () => after.createRoom());
    assert.equal(all.filter(Boolean).length, 50);
    assert.equal(all[0].roomNumber, 1);
    assert.equal(new Set(all.map(r => r.roomNumber)).size, 50);
    assert.equal(after.createRoom(), null);
    assert.ok(all.every(room => room.roomNumber === 1 || room.roomNumber >= 15));
});
