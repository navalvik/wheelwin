import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RoomManager } from "../managers/RoomManager.js";
import { loadRoomConfig } from "../config/rooms.js";
import { RoomWalletRegistry } from "../payment/roomWallet/RoomWalletRegistry.js";
import { RoomWalletRefundRecoveryRepository } from "../payment/roomWallet/RoomWalletRefundRecoveryRepository.js";
import { RoomWalletRefundDestructionGuard } from "../payment/roomWallet/RoomWalletRefundDestructionGuard.js";
import { TonFinancialPersistence } from "../persistence/TonFinancialPersistence.js";

const wallet = "EQDGQjwaP0OSExa9MfZih61De5TQuUITQPYiYZyfqAFzpvQB";
const logger = { warn() {}, error() {}, info() {}, decisionTrace() {} };
const eventBus = { emit() {}, subscribe() {}, unsubscribe() {} };

function storage(t) {
    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-load50-"));
    let current = null;
    const open = () => {
        const persistence = new TonFinancialPersistence({ dataDir });
        persistence.initialize();
        current = persistence;
        const repo = new RoomWalletRefundRecoveryRepository({ financialPersistence: persistence });
        return { repo, persistence };
    };
    t.after(() => {
        current?.shutdown({ checkpoint: false });
        rmSync(dataDir, { recursive: true, force: true });
    });
    return open;
}

function newRoomManager({ guard = null, closure = null, maxConcurrentRooms = 50 } = {}) {
    const m = new RoomManager({
        logger,
        eventBus,
        roomConfig: { maxPlayers: 3, maxConcurrentRooms }
    });
    let id = 0;
    m._generateRoomId = () => "test50_" + (++id);
    m.attachSetupSessionLifecycle({
        createForRoom() { return {}; },
        abortForRoom() { return true; }
    });
    if (guard) m.attachRoomWalletAllocationGuard(guard);
    if (closure) m.attachRoomWalletDestructionGuard(closure);
    return m;
}

function markQuarantined(repo, number) {
    return repo.beginQuarantine({
        roomId: "unsettled_" + number,
        roomNumber: number,
        roomWallet: wallet,
        gameId: "game_" + number,
        paymentSessionId: "payment_" + number
    });
}

test("load policy: default exactly 50, rejects 51 or 64 and fractional capacity", () => {
    assert.equal(loadRoomConfig({ ROOM_MAX_PLAYERS: "3" }).maxConcurrentRooms, 50);
    assert.equal(loadRoomConfig({ ROOM_MAX_PLAYERS: "3", ROOM_MAX_CONCURRENT: "48" }).maxConcurrentRooms, 48);
    for (const invalid of ["51", "64", "100", "50.5", "-1", "0", "junk"]) {
        assert.throws(() => loadRoomConfig({
            ROOM_MAX_PLAYERS: "3",
            ROOM_MAX_CONCURRENT: invalid
        }), /ROOM_MAX_CONCURRENT/, invalid);
    }
});

test("50-room ceiling is strict even if an old config asks for 64", () => {
    const m = newRoomManager({ maxConcurrentRooms: 64 });
    const rooms = Array.from({ length: 50 }, () => m.createRoom({ maxPlayers: 3 }));
    assert.ok(rooms.every(Boolean));
    assert.equal(new Set(rooms.map(x => x.roomNumber)).size, 50);
    assert.equal(m.getActiveRoomCount(), 50);
    assert.equal(m.getMaxConcurrentRooms(), 50);
    assert.equal(m.createRoom({ maxPlayers: 3 }), null);
    assert.equal(m.getActiveRoomCount(), 50);
    assert.ok(rooms.every(x => x.players.length === 0 && x.maxPlayers === 3));
});

test("14 unresolved wallets are quarantined while 50 clean rooms remain allocatable", (t) => {
    const { repo } = storage(t)();
    for (let n = 1; n <= 14; n++) markQuarantined(repo, n);
    const m = newRoomManager({ guard: repo });
    const rooms = Array.from({ length: 50 }, () => m.createRoom());
    assert.ok(rooms.every(Boolean));
    assert.deepEqual(rooms.map(x => x.roomNumber), Array.from({ length: 50 }, (_, i) => i + 15));
    assert.equal(m.createRoom(), null);
    assert.equal(repo.listOpenQuarantines().length, 14);
    assert.equal(repo.isRoomNumberQuarantined(1), true);
    assert.equal(repo.isRoomNumberQuarantined(15), false);
});

test("15 quarantined wallets reduce safe capacity below 50 instead of reusing funds", (t) => {
    const { repo } = storage(t)();
    for (let n = 1; n <= 15; n++) markQuarantined(repo, n);
    const m = newRoomManager({ guard: repo });
    const rooms = Array.from({ length: 49 }, () => m.createRoom());
    assert.ok(rooms.every(Boolean));
    assert.equal(m.getActiveRoomCount(), 49);
    assert.equal(m.createRoom(), null);
    assert.equal(m.getActiveRoomCount(), 49);
    assert.ok(rooms.every(x => x.roomNumber > 15));
});

test("persistent quarantine survives process restart and blocks room 1 again", (t) => {
    const open = storage(t);
    const first = open();
    markQuarantined(first.repo, 1);
    first.persistence.shutdown({ checkpoint: false });
    const afterBoot = open();
    const m = newRoomManager({ guard: afterBoot.repo });
    assert.equal(afterBoot.repo.isRoomNumberQuarantined(1), true);
    assert.equal(m.createRoom().roomNumber, 2);
});

test("pre-Page5 destruction writes durable quarantine before releasing wallet number", (t) => {
    const { repo, persistence } = storage(t)();
    const m = newRoomManager({ guard: repo });
    const room = m.createRoom();
    assert.equal(room.roomNumber, 1);
    const session = {
        roomId: room.roomId,
        roomNumber: room.roomNumber,
        network: "testnet",
        gameId: "game_bob_lena_olga",
        paymentSessionId: "payment_3_seats",
        roomWalletAddress: wallet
    };
    const closure = new RoomWalletRefundDestructionGuard({
        repository: repo,
        paymentSessionManager: { getSession: (roomId) => roomId === room.roomId ? session : null },
        setupSessionLifecycle: { isGameplayOwnershipReleased: () => false },
        financialPersistence: persistence,
        roomWalletRegistry: new RoomWalletRegistry({
            entries: [{ roomNumber: 1, address: wallet }]
        })
    });
    m.attachRoomWalletDestructionGuard(closure);
    assert.equal(m.destroyRoom(room.roomId), true);
    assert.equal(repo.isRoomNumberQuarantined(1), true);
    assert.equal(repo.listOpenQuarantines()[0].payload.paymentSessionId, session.paymentSessionId);
    assert.equal(m.createRoom().roomNumber, 2);
});

test("missing in-memory payment session falls back to the persisted payment record", (t) => {
    const { repo, persistence } = storage(t)();
    const m = newRoomManager({ guard: repo });
    const room = m.createRoom();
    persistence.createPaymentSession({
        paymentSessionId: "stored_session_1",
        roomId: room.roomId,
        roomNumber: 1,
        gameId: "stored_game_1",
        roomWalletAddress: wallet,
        network: "testnet",
        status: "PAYMENT_TIMEOUT"
    }, {
        paymentSessionId: "stored_session_1",
        roomId: room.roomId,
        gameId: "stored_game_1",
        tonNetwork: "testnet"
    });
    m.attachRoomWalletDestructionGuard(new RoomWalletRefundDestructionGuard({
        repository: repo,
        paymentSessionManager: { getSession: () => null },
        setupSessionLifecycle: { isGameplayOwnershipReleased: () => false },
        financialPersistence: persistence,
        roomWalletRegistry: new RoomWalletRegistry({
            entries: [{ roomNumber: 1, address: wallet }]
        })
    }));
    assert.equal(m.destroyRoom(room.roomId), true);
    assert.equal(repo.isRoomNumberQuarantined(1), true);
});

test("Page5-owned room is blocked until winner and owner transfers reconcile", (t) => {
    const { repo, persistence } = storage(t)();
    const m = newRoomManager({ guard: repo });
    const room = m.createRoom();
    m.attachRoomWalletDestructionGuard(new RoomWalletRefundDestructionGuard({
        repository: repo,
        paymentSessionManager: { getSession: () => ({
            roomId: room.roomId,
            gameId: "game_result_page5",
            network: "testnet",
            roomWalletAddress: wallet
        }) },
        setupSessionLifecycle: { isGameplayOwnershipReleased: () => true },
        financialPersistence: persistence,
        roomWalletRegistry: new RoomWalletRegistry({
            entries: [{ roomNumber: 1, address: wallet }]
        })
    }));
    assert.equal(m.destroyRoom(room.roomId), true);
    // Post-Page5 can NEVER create a pre-Page5 refund obligation.
    assert.equal(repo.listOpenQuarantines().length, 0);
    assert.equal(repo.listOpenSettlementQuarantines().length, 1);
    assert.equal(repo.isRoomNumberQuarantined(1), true);
    assert.equal(m.createRoom().roomNumber, 2);
});

test("filesystem failure blocks room destruction and retains wallet allocation", (t) => {
    const { repo, persistence } = storage(t)();
    const m = newRoomManager({ guard: repo });
    const room = m.createRoom();
    let failed = false;
    m.attachRoomWalletDestructionGuard({
        prepareRoomForDestruction() {
            failed = true;
            throw new Error("write volume unavailable");
        }
    });
    assert.equal(m.destroyRoom(room.roomId), false);
    assert.equal(failed, true);
    assert.equal(m.getActiveRoomCount(), 1);
    assert.equal(m.getRoom(room.roomId)?.roomNumber, 1);
    assert.equal(m.createRoom().roomNumber, 2);
    assert.equal(repo.isRoomNumberQuarantined(1), false);
    persistence.shutdown({ checkpoint: false });
});


test("unproven Page5 payout identity retains the active room and its wallet", (t) => {
    const { repo, persistence } = storage(t)();
    const m = newRoomManager({ guard: repo });
    const room = m.createRoom();
    m.attachRoomWalletDestructionGuard(new RoomWalletRefundDestructionGuard({
        repository: repo,
        paymentSessionManager: { getSession: () => null },
        setupSessionLifecycle: { isGameplayOwnershipReleased: () => true },
        financialPersistence: persistence,
        roomWalletRegistry: new RoomWalletRegistry({
            entries: [{ roomNumber: 1, address: wallet }]
        })
    }));
    assert.equal(m.destroyRoom(room.roomId), false);
    assert.equal(m.getRoom(room.roomId)?.roomNumber, 1);
    assert.equal(m.createRoom().roomNumber, 2);
});

test("post-Page5 settlement quarantine persists after Railway-style restart", (t) => {
    const open = storage(t);
    const first = open();
    const marker = first.repo.beginSettlementQuarantine({
        network: "testnet", roomId: "room_page5", roomNumber: 1,
        gameId: "game_completed_but_payout_pending", roomWallet: wallet
    });
    assert.equal(marker.created, true);
    assert.equal(first.repo.isRoomNumberQuarantined(1), true);
    assert.equal(first.repo.beginSettlementQuarantine({
        network: "testnet", roomId: "room_page5", roomNumber: 1,
        gameId: "game_completed_but_payout_pending", roomWallet: wallet
    }).created, false);
    first.persistence.shutdown({ checkpoint: false });

    const recovered = open();
    assert.equal(recovered.repo.listOpenQuarantines().length, 0);
    assert.equal(recovered.repo.listOpenSettlementQuarantines().length, 1);
    assert.equal(recovered.repo.isRoomNumberQuarantined(1), true);
    const manager = newRoomManager({ guard: recovered.repo });
    assert.equal(manager.createRoom().roomNumber, 2);
});

test("post-Page5 settlement marker is never interpreted as a refund worker task", (t) => {
    const { repo } = storage(t)();
    repo.beginSettlementQuarantine({
        network: "testnet", roomId: "afterPage5", roomNumber: 1,
        gameId: "game_terminal", roomWallet: wallet
    });
    assert.equal(repo.listOpenQuarantines().length, 0);
    assert.equal(repo.listOpenSettlementQuarantines().length, 1);
    assert.equal(repo.listAllocationBlocks().length, 1);
});
