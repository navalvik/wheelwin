import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TonFinancialPersistence } from "../persistence/TonFinancialPersistence.js";
import { RoomWalletRefundRecoveryRepository } from "../payment/roomWallet/RoomWalletRefundRecoveryRepository.js";
import { RoomWalletOutboundIntentJournal } from "../payment/roomWallet/RoomWalletOutboundIntentJournal.js";
import { RoomWalletGuardedPayoutCoordinator } from "../payment/roomWallet/RoomWalletGuardedPayoutCoordinator.js";

const ROOM = "0:c6423c1a3f43921316bd31f66287ad437b94d0b9421340f622619c9fa80173a6";
const PEOPLE = [
    ["Olga", "0:bdab0280cbbda45f5a0fb6bc97fa0e72e380769986440761d574901e269ae56b"],
    ["Lena", "0:de5819f3012bf5bb3f0e502aa3a066ffcab5bf4d52dcf384b9b33a857e3907c8"],
    ["Bob", "0:2d8205bb979c1f41c3f2cb7f18ee656e5e7874c111dca4528f21db426dc4476f"]
];
const SESSION_ID = "pay_protected_oj7v";
const GAME_ID = "game_protected_oj7v";
const NET_NANO = "998611722";
const GAS_NANO = "1388278";
const REFUND_PLAN = Object.freeze({
    mode: "RECIPIENT_PAYS_GAS",
    entries: PEOPLE.map(([playerId, wallet]) => ({
        playerId, wallet, grossRefundNano: "1000000000",
        recipientGasChargeNano: GAS_NANO,
        recipientTransferAmountNano: NET_NANO
    }))
});

function fixture(t) {
    const dir = mkdtempSync(join(tmpdir(), "ww-real-ledger-"));
    let active;
    function open() {
        const persistence = new TonFinancialPersistence({ dataDir: dir });
        persistence.initialize();
        const repo = new RoomWalletRefundRecoveryRepository({
            financialPersistence: persistence
        });
        const journal = new RoomWalletOutboundIntentJournal({
            financialPersistence: persistence
        });
        active = { persistence, repo, journal };
        return active;
    }
    t.after(() => {
        active?.persistence?.shutdown({ checkpoint: false });
        rmSync(dir, { recursive: true, force: true });
    });
    const f = open();
    const session = {
        roomId: "oj7v", gameId: GAME_ID,
        paymentSessionId: SESSION_ID, roomNumber: 1,
        roomWalletAddress: ROOM, network: "testnet",
        createdAt: 1792892541339,
        recoveryMetadata: { refundPlan: REFUND_PLAN }
    };
    f.persistence.createPaymentSession(session, {
        paymentSessionId: SESSION_ID, roomId: "oj7v",
        gameId: GAME_ID, tonNetwork: "testnet"
    });
    for (let i = 0; i < PEOPLE.length; i++) {
        const [playerId, recipientWallet] = PEOPLE[i];
        const recoveryRecordId = "rwrefund_" + (i + 1).toString(16).repeat(64);
        f.persistence.createRecoveryDataRecord({
            recoveryRecordId, kind: "ROOM_WALLET_REFUND_OBLIGATION",
            network: "testnet", status: "ACTIVE",
            state: "REFUND_RECONCILIATION_REQUIRED",
            executionAllowed: true,
            roomId: "oj7v", roomNumber: 1, gameId: GAME_ID,
            paymentSessionId: SESSION_ID, fromRoomWallet: ROOM,
            playerId, recipientWallet, grossRefundNano: "1000000000",
            inboundLt: String(100 + i),
            inboundTxHash: (i + 4).toString(16).repeat(64)
        }, { recoveryRecordId, roomId: "oj7v", gameId: GAME_ID,
            status: "ACTIVE", tonNetwork: "testnet" });
    }
    function coordinator(current, sends) {
        const executor = {
            async execute({ intentId }) {
                const before = current.journal.load(intentId);
                if (before.payload.state !== "PLANNED") {
                    return { state: "CONFIRMATION_UNKNOWN", broadcasted: false };
                }
                sends.push(intentId);
                current.journal.holdSignedMessage({
                    intentId, seqno: 41 + sends.length,
                    signedExternalMessageHash: "b".repeat(64),
                    validUntil: 1792902000
                });
                current.journal.markConfirmationUnknown(intentId);
                return { state: "CONFIRMATION_UNKNOWN", broadcasted: true };
            }
        };
        return new RoomWalletGuardedPayoutCoordinator({
            journal: current.journal, executor,
            financialPersistence: current.persistence,
            refundRecoveryRepository: current.repo
        });
    }
    const args = {
        roomNumber: 1, roomId: "oj7v", gameId: GAME_ID,
        paymentSessionId: SESSION_ID,
        refundPlan: REFUND_PLAN,
        refunds: PEOPLE.slice(1).map(([playerId, wallet]) => ({
            playerId, wallet, amountNano: "1000000000"
        }))
    };
    function confirm(current, intentId, seqno) {
        const data = current.journal.load(intentId).payload;
        return current.journal.confirmWithChainProof({
            intentId, observedSeqno: seqno + 1,
            evidence: {
                confirmed: true, state: "CHAIN_CONFIRMED",
                receipt: {
                    account: ROOM, recipient: data.destinationWallet,
                    valueNano: NET_NANO,
                    signedExternalMessageHash: data.signedExternalMessageHash,
                    roomWalletTxHash: "c".repeat(64),
                    roomWalletTxLt: String(10000 + seqno),
                    outboundMessageHash: "d".repeat(64)
                }
            }
        });
    }
    return { ...f, open, coordinator, confirm, args };
}

test("historical Olga already excluded, Lena and Bob enter the protected payer queue", async t => {
    const f = fixture(t);
    const sends = [];
    const coordinator = f.coordinator(f, sends);
    const first = await coordinator.refundPayments(f.args);
    assert.equal(first.code, "GUARDED_REFUND_CONFIRMATION_PENDING");
    assert.deepEqual(first.results.map(x => x.playerId), ["Lena"]);
    assert.equal(sends.length, 1);
    assert.equal(f.journal.load(sends[0]).payload.destinationWallet, PEOPLE[1][1]);
    await coordinator.refundPayments(f.args);
    assert.equal(sends.length, 1, "unknown response never causes duplicate");
    const seqno = f.journal.load(sends[0]).payload.seqno;
    f.confirm(f, sends[0], seqno);
    const second = await coordinator.refundPayments(f.args);
    assert.equal(second.code, "GUARDED_REFUND_CONFIRMATION_PENDING");
    assert.equal(second.results[0].ok, true);
    assert.equal(second.results[0].txHash, "c".repeat(64));
    assert.equal(sends.length, 2);
    assert.equal(f.journal.load(sends[1]).payload.destinationWallet, PEOPLE[2][1]);
    f.confirm(f, sends[1], f.journal.load(sends[1]).payload.seqno);
    const final = await coordinator.refundPayments(f.args);
    assert.equal(final.ok, true);
    assert.equal(final.results.length, 2);
    assert.equal(sends.length, 2);
});

test("persistent re-open keeps unknown transfer held without signing it again", async t => {
    const f = fixture(t);
    const sends = [];
    await f.coordinator(f, sends).refundPayments(f.args);
    f.persistence.shutdown({ checkpoint: false });
    const recovered = f.open();
    const result = await f.coordinator(recovered, sends).refundPayments(f.args);
    assert.equal(result.code, "GUARDED_REFUND_CONFIRMATION_PENDING");
    assert.equal(sends.length, 1);
    assert.equal(recovered.journal.load(sends[0]).payload.state, "CONFIRMATION_UNKNOWN");
});

test("same addresses in another game cannot adopt oj7v debts", async t => {
    const f = fixture(t);
    const sends = [];
    const result = await f.coordinator(f, sends).refundPayments({
        ...f.args, gameId: "another_game"
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "GUARDED_REFUND_PROOF_NOT_AUTHORIZED");
    assert.equal(sends.length, 0);
});

test("plan gas or recipient tampering cannot borrow the existing ledger", async t => {
    const f = fixture(t);
    const sends = [];
    const coordinator = f.coordinator(f, sends);
    const wrongFee = {
        ...REFUND_PLAN,
        entries: REFUND_PLAN.entries.map((p, i) => i === 1
            ? { ...p, recipientGasChargeNano: "1300000",
                recipientTransferAmountNano: "998700000" }
            : p)
    };
    const result = await coordinator.refundPayments({
        ...f.args, refundPlan: wrongFee
    });
    assert.equal(result.code, "GUARDED_REFUND_PROOF_NOT_AUTHORIZED");
    assert.equal(sends.length, 0);
});
