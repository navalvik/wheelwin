import test from "node:test";
import assert from "node:assert/strict";

import { loadRoomConfig } from "../config/rooms.js";
import { RoomDeadline } from "../payment/RoomDeadline.js";
import { ROOM_LIFETIME_MS, ROOM_WALLET_POOL_SIZE } from "../payment/RoomPaymentConstants.js";
import { SetupSessionLifecycle } from "../gameplay/SetupSessionLifecycle.js";
import { RoomManager } from "../managers/RoomManager.js";

const FIVE_MINUTES = 300_000;

function config(extra = {}) {
    return loadRoomConfig({ ROOM_MAX_PLAYERS: "3", ...extra });
}

test("Testnet setup and payment deadlines use same five-minute room lifetime", () => {
    const cfg = config();
    assert.equal(cfg.setupDurationMs, FIVE_MINUTES);
    assert.equal(cfg.paymentSessionDurationMs, FIVE_MINUTES);
    assert.equal(ROOM_LIFETIME_MS, FIVE_MINUTES);
    assert.equal(ROOM_WALLET_POOL_SIZE, 64);
    const roomCreatedAt = 1_800_000_000_000;
    const deadline = new RoomDeadline(roomCreatedAt);
    assert.equal(deadline.deadlineMs, roomCreatedAt + FIVE_MINUTES);
    assert.equal(deadline.remainingMs(roomCreatedAt + 299_999), 1);
    assert.equal(deadline.remainingMs(roomCreatedAt + FIVE_MINUTES), 0);
    assert.equal(deadline.isReached(roomCreatedAt + FIVE_MINUTES), true);
    // A late Page4 entry cannot give the payer another five minutes.
    assert.equal(deadline.remainingMs(roomCreatedAt + 240_000), 60_000);
});

test("environment cannot extend setup or payment beyond the single five-minute limit", () => {
    assert.throws(() => config({ SETUP_DURATION_MS: "480000" }), /SETUP_DURATION_MS/);
    assert.throws(() => config({ PAYMENT_SESSION_DURATION_MS: "480000" }), /PAYMENT_SESSION_DURATION_MS/);
    assert.throws(() => config({ SETUP_DURATION_MS: "300001" }), /SETUP_DURATION_MS/);
    assert.throws(() => config({ PAYMENT_SESSION_DURATION_MS: "300001" }), /PAYMENT_SESSION_DURATION_MS/);
    assert.equal(config({ SETUP_DURATION_MS: "240000" }).setupDurationMs, 240_000);
    assert.equal(config({ PAYMENT_SESSION_DURATION_MS: "240000" }).paymentSessionDurationMs, 240_000);
});

test("admin setup-timer changes and constructor overrides never extend the five-minute ceiling", () => {
    const fake = { info() {}, warn() {}, error() {} };
    const s = new SetupSessionLifecycle({
        logger: fake, eventBus: {},
        roomManager: {}, roomConfig: { setupDurationMs: 480_000 }
    });
    assert.equal(s.getDurationMs(), FIVE_MINUTES);
    assert.equal(s.setDurationMs(900_000), FIVE_MINUTES);
    assert.equal(s.setDurationMs(150_000), 150_000);
});

test("no environment may configure more than fifty concurrent rooms", () => {
    assert.equal(config().maxConcurrentRooms, 50);
    assert.equal(config({ ROOM_MAX_CONCURRENT: "50" }).maxConcurrentRooms, 50);
    assert.throws(() => config({ ROOM_MAX_CONCURRENT: "51" }), /ROOM_MAX_CONCURRENT/);
    assert.throws(() => config({ ROOM_MAX_CONCURRENT: "64" }), /ROOM_MAX_CONCURRENT/);
    assert.throws(() => config({ ROOM_MAX_CONCURRENT: "50.5" }), /ROOM_MAX_CONCURRENT/);
});

test("RoomManager actually refuses room number 51 even with a bypassed high config", () => {
    const logger = { info() {}, warn() {}, error() {} };
    const eventBus = { emit() {}, subscribe() {}, unsubscribe() {} };
    const manager = new RoomManager({
        logger, eventBus,
        roomConfig: { maxPlayers: 3, maxConcurrentRooms: 64 }
    });
    manager.attachSetupSessionLifecycle({
        createForRoom() { return { expiresAt: Date.now() + FIVE_MINUTES }; }
    });
    const rooms = Array.from({ length: 50 }, () => manager.createRoom());
    assert.equal(rooms.filter(Boolean).length, 50);
    assert.deepEqual(rooms.map(r => r.roomNumber), Array.from({ length: 50 }, (_, i) => i + 1));
    assert.equal(manager.createRoom(), null);
    assert.equal(new Set(rooms.map(r => r.roomId)).size, 50);
});

test("recovered rooms consume all fifty slots and room-number reuse requires a detach", async () => {
    const { Room } = await import("../models/Room.js");
    const logger = { info() {}, warn() {}, error() {} };
    const eventBus = { emit() {}, subscribe() {}, unsubscribe() {} };
    const manager = new RoomManager({
        logger, eventBus, roomConfig: { maxPlayers: 3, maxConcurrentRooms: 50 }
    });
    manager.attachSetupSessionLifecycle({
        createForRoom() { return { expiresAt: Date.now() + FIVE_MINUTES }; }
    });

    for (let n = 1; n <= 50; n += 1) {
        const room = new Room({
            roomId: "recovered-" + n,
            roomNumber: n,
            createdAt: 1_800_000_000_000,
            maxPlayers: 3,
            players: []
        });
        assert.equal(manager.attachRoom(room), room);
    }
    assert.equal(manager.getActiveRoomCount(), 50);
    assert.equal(manager.isAtCapacity(), true);
    assert.equal(manager.createRoom(), null);
    assert.equal(manager.attachRoom(new Room({roomId:"illegal-51", roomNumber:51})), null);

    assert.equal(manager.detachRoom("recovered-7"), true);
    assert.equal(manager.getActiveRoomCount(), 49);
    const replacement = manager.createRoom();
    assert.ok(replacement);
    assert.equal(replacement.roomNumber, 7);
    assert.equal(manager.getActiveRoomCount(), 50);
    assert.equal(manager.createRoom(), null);
});
