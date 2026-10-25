/**
 * Offline-only: durable obligations and safe Room Wallet reallocation.
 * No TON network, no signer, no escrow or smart contracts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Address } from "@ton/core";

import { TonFinancialPersistence } from "../persistence/TonFinancialPersistence.js";
import { RoomManager } from "../managers/RoomManager.js";
import { buildExpiredRoomWalletRefundObligations } from "../payment/roomWallet/RoomWalletExpiredRefundObligations.js";
import {
    RoomWalletRefundRecoveryRepository
} from "../payment/roomWallet/RoomWalletRefundRecoveryRepository.js";

const roomRaw = "0:c6423c1a3f43921316bd31f66287ad437b94d0b9421340f622619c9fa80173a6";
const roomWallet = Address.parseRaw(roomRaw).toString();
const players = [
    { playerId: "olga", raw: "0:bdab0280cbbda45f5a0fb6bc97fa0e72e380769986440761d574901e269ae56b", hash: "488351bef406163cf3fc0546e53d6472324e77b787a56a628f1e24c776d99ca3", lt: "105264227000003", utime: 1792892552 },
    { playerId: "lena", raw: "0:de5819f3012bf5bb3f0e502aa3a066ffcab5bf4d52dcf384b9b33a857e3907c8", hash: "42e85d64a448206c739b0a953ca22ba0368409425c193ec0bfd4409aceaba72a", lt: "105264234000003", utime: 1792892555 },
    { playerId: "bob", raw: "0:2d8205bb979c1f41c3f2cb7f18ee656e5e7874c111dca4528f21db426dc4476f", hash: "a3692566ccc78cf87097af572aa573aaf6c0b460c8d11182c5a4850b8a68f5ef", lt: "105264240000003", utime: 1792892557 }
];
const session = {
    network: "testnet",
    roomId: "oj7v",
    roomNumber: 1,
    gameId: "game_c2e30d65-2194-432f-8cc5-267d935e8fc4",
    paymentSessionId: "pay_cf9ef2f2-1026-4916-80f8-92392904a44a",
    roomWalletAddress: roomWallet,
    createdAt: 1792892541339,
    paymentDeadline: 1792893021339,
    receivedPayments: [],
    participants: players.map(p => ({
        playerId: p.playerId,
        wallet: Address.parseRaw(p.raw).toString(),
        requiredGram: 1,
        refunded: false
    }))
};
function plan(overrides = {}) {
    return buildExpiredRoomWalletRefundObligations({
        session,
        gameReachedPage5: false,
        historyComplete: true,
        chainEvidence: {
            source: "tonapi+toncenter-v3",
            awaitingSecondProvider: 0,
            transactions: players.map(p => ({
                success: true,
                transaction_id: { lt: p.lt, hash: p.hash },
                utime: p.utime,
                in_msg: { source: p.raw, destination: roomRaw, value: "1000000000" }
            }))
        },
        ...overrides
    });
}
function makeStorage(t) {
    const dir = mkdtempSync(join(tmpdir(), "wheelwin-oj7v-refund-"));
    let current = null;
    const open = () => {
        const persistence = new TonFinancialPersistence({ dataDir: dir, autoCheckpoint: true });
        persistence.initialize();
        current = persistence;
        return {
            persistence,
            store: new RoomWalletRefundRecoveryRepository({ financialPersistence: persistence })
        };
    };
    t.after(() => {
        current?.shutdown({ checkpoint: false });
        rmSync(dir, { recursive: true, force: true });
    });
    return open;
}

test("oj7v: durable refund ledger captures 3 deposits despite empty payment session", (t) => {
    const { store } = makeStorage(t)();
    const p = plan();
    const result = store.persistReconciliation({ plan: p, session, gameReachedPage5: false });
    assert.equal(session.receivedPayments.length, 0);
    assert.equal(result.obligationsCreated, 3);
    assert.equal(result.quarantineCreated, true);
    assert.equal(result.walletQuarantined, true);
    assert.equal(store.listOpenQuarantines().length, 1);
    assert.equal(store.listRefundObligations({ roomId: "oj7v" }).length, 3);
    assert.deepEqual(
        store.listRefundObligations({ roomId: "oj7v" }).map(x => x.payload.grossRefundNano).sort(),
        ["1000000000", "1000000000", "1000000000"]
    );
    assert.equal(store.isRoomNumberQuarantined(1), true);
    assert.equal(store.isRoomNumberQuarantined(2), false);
});

test("quarantine and debt survive TonFinancialPersistence restart", (t) => {
    const open = makeStorage(t);
    const first = open();
    first.store.persistReconciliation({ plan: plan(), session, gameReachedPage5: false });
    first.persistence.shutdown({ checkpoint: false });

    const recovered = open();
    assert.equal(recovered.store.isRoomNumberQuarantined(1), true);
    assert.equal(recovered.store.listRefundObligations().length, 3);
    const replay = recovered.store.persistReconciliation({
        plan: plan(), session, gameReachedPage5: false
    });
    assert.equal(replay.quarantineCreated, false);
    assert.equal(replay.obligationsCreated, 0);
    assert.equal(recovered.store.listRefundObligations().length, 3);
});

test("partial write crash preserves quarantine; next process repairs missing obligations", (t) => {
    const open = makeStorage(t);
    const first = open();
    const original = first.persistence.createRecoveryDataRecord.bind(first.persistence);
    let calls = 0;
    first.persistence.createRecoveryDataRecord = (...args) => {
        calls++;
        if (calls === 3) throw new Error("simulated disk failure after guard and first obligation");
        return original(...args);
    };
    assert.throws(
        () => first.store.persistReconciliation({
            plan: plan(), session, gameReachedPage5: false
        }),
        /simulated disk failure/
    );
    assert.equal(first.store.isRoomNumberQuarantined(1), true);
    assert.equal(first.store.listRefundObligations().length, 1);
    first.persistence.shutdown({ checkpoint: false });

    const recovered = open();
    assert.equal(recovered.store.isRoomNumberQuarantined(1), true);
    assert.equal(recovered.store.listRefundObligations().length, 1);
    const replay = recovered.store.persistReconciliation({
        plan: plan(), session, gameReachedPage5: false
    });
    assert.equal(replay.obligationsCreated, 2);
    assert.equal(recovered.store.listRefundObligations().length, 3);
});

test("contradictory evidence for the same obligation ID cannot overwrite persisted debt", (t) => {
    const { store } = makeStorage(t)();
    store.persistReconciliation({ plan: plan(), session, gameReachedPage5: false });
    const changed = plan();
    const obligations = changed.obligations.map((x, index) =>
        index === 0 ? { ...x, grossRefundNano: "2000000000" } : x
    );
    assert.throws(
        () => store.persistReconciliation({
            plan: { ...changed, obligations }, session, gameReachedPage5: false
        }),
        (e) => e.code === "OBLIGATION_EVIDENCE_CONFLICT"
    );
    assert.equal(store.listRefundObligations().length, 3);
});

test("unverified Page5 ownership cannot start a durable refund", (t) => {
    const { store } = makeStorage(t)();
    for (const value of [null, true]) {
        assert.throws(
            () => store.persistReconciliation({
                plan: plan(), session, gameReachedPage5: value
            }),
            (e) => e.code === "PAGE5_OWNERSHIP_NOT_EXCLUDED"
        );
    }
    assert.equal(store.listOpenQuarantines().length, 0);
});

test("failed or incomplete dual-provider scan stays quarantined with zero deposits", (t) => {
    const { store } = makeStorage(t)();
    const p = plan({
        historyComplete: false,
        chainEvidence: {
            source: "tonapi+toncenter-v3",
            awaitingSecondProvider: 3,
            transactions: []
        }
    });
    assert.equal(p.obligations.length, 0);
    const persisted = store.persistReconciliation({
        plan: p, session, gameReachedPage5: false
    });
    assert.equal(persisted.obligationsCreated, 0);
    assert.equal(store.isRoomNumberQuarantined(1), true);
});

test("quarantine must be durable before financial allocations are permitted", (t) => {
    const { store } = makeStorage(t)();
    store.beginQuarantine({
        network: "testnet", roomId: "oj7v", roomNumber: 1,
        gameId: session.gameId,
        paymentSessionId: session.paymentSessionId,
        roomWallet
    });
    const logger = { error() {}, info() {}, warn() {} };
    const roomManager = new RoomManager({
        logger,
        eventBus: {},
        roomConfig: { maxConcurrentRooms: 64, maxPlayers: 3 }
    });
    roomManager.attachRoomWalletAllocationGuard(store);
    assert.equal(roomManager._allocateRoomNumber(), 2);
    assert.equal(roomManager._claimExistingOrAllocateRoomNumber({ roomNumber: 1 }), false);
    assert.equal(store.isRoomNumberQuarantined(1), true);
    // RoomManager must not clear a persisted safety guard when releasing.
    roomManager._releaseRoomNumber(1);
    assert.equal(store.isRoomNumberQuarantined(1), true);
});

test("allocation gate errors fail closed rather than handing out unsafe wallet 1", () => {
    const roomManager = new RoomManager({
        logger: { error() {}, info() {}, warn() {} },
        eventBus: {},
        roomConfig: { maxConcurrentRooms: 64 }
    });
    roomManager.attachRoomWalletAllocationGuard({
        isRoomNumberQuarantined() {
            throw new Error("storage IO unavailable");
        }
    });
    assert.throws(() => roomManager._allocateRoomNumber(), /storage IO unavailable/);
    assert.throws(() => roomManager._claimExistingOrAllocateRoomNumber({ roomNumber: 1 }), /storage IO unavailable/);
});

test("quarantine identity mismatch cannot be overwritten", (t) => {
    const { store } = makeStorage(t)();
    const base = {
        roomId: session.roomId, roomNumber: 1,
        gameId: session.gameId, paymentSessionId: session.paymentSessionId,
        roomWallet
    };
    const initial = store.beginQuarantine(base);
    assert.equal(initial.created, true);
    assert.equal(store.beginQuarantine(base).created, false);
    assert.throws(
        () => store.beginQuarantine({ ...base, roomWallet: Address.parseRaw(players[0].raw).toString() }),
        (error) => error.code === "QUARANTINE_IDENTITY_CONFLICT"
    );
});

test("ledger remains read-only: no refund signing or confirmation shortcut exists", (t) => {
    const { store } = makeStorage(t)();
    assert.equal(typeof store.sendTransfer, "undefined");
    assert.equal(typeof store.markRefundConfirmed, "undefined");
    assert.equal(typeof store.closeQuarantine, "undefined");
});
