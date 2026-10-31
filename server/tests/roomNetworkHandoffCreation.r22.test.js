/**
 * R22 — server-owned runtime selection replaces the historical client-driven
 * post-CREATE_ROOM Mainnet handoff trigger. Cross-runtime handoffs are tested
 * through the authenticated R23 bootstrap path.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
    LOBBY_ERROR_CODES,
    LOBBY_SERVER_EVENTS
} from "../socket/lobbyProtocol.js";
import { createServerOwnedRoomNetworkHarness } from "./helpers/serverOwnedRoomNetworkHarness.js";

test("Mainnet runtime creates an ordinary Mainnet room without a client handoff request", () => {
    const harness = createServerOwnedRoomNetworkHarness({
        network: "mainnet",
        withHandoffStore: true
    });
    try {
        harness.authenticate("owner", 94001);
        const created = harness.createRoom("owner", {
            network: "testnet",
            targetNetwork: "testnet",
            ownerPlayerId: "forged-owner"
        });
        const roomId = created?.payload?.roomId;
        assert.ok(roomId);
        assert.equal(created.payload.network, "mainnet");
        assert.equal(harness.bridge._roomNetworkByRoom.get(roomId), "mainnet");

        // The obsolete client-side selector cannot change the room or create
        // a handoff. The owner uses the Mainnet runtime selected at entry.
        harness.selectNetwork("owner", "mainnet", {
            roomId: "forged-room",
            telegramUserId: 99999
        });
        assert.equal(
            harness.socketDelivery("owner", LOBBY_SERVER_EVENTS.ROOM_ERROR)?.payload?.code,
            LOBBY_ERROR_CODES.ROOM_NETWORK_ALREADY_SELECTED
        );
        assert.equal(harness.handoffStore.createCalls.length, 0);
        assert.equal(harness.countDeliveries(LOBBY_SERVER_EVENTS.ROOM_NETWORK_HANDOFF_READY), 0);
        assert.equal(harness.roomManager.getActiveRoomCount(), 1,
            "a repeated client selection must not create a duplicate room");
        assert.equal(harness.bridge._roomNetworkByRoom.get(roomId), "mainnet");
    } finally {
        harness.close();
    }
});

test("Testnet runtime ignores forged Mainnet creation fields and never arms a handoff", () => {
    const harness = createServerOwnedRoomNetworkHarness({
        network: "testnet",
        withHandoffStore: true
    });
    try {
        const denied = harness.createRoom("anonymous", {
            network: "mainnet",
            targetNetwork: "mainnet",
            telegramUserId: 94002
        });
        assert.equal(denied, null);
        assert.equal(
            harness.socketDelivery("anonymous", LOBBY_SERVER_EVENTS.ROOM_ERROR)?.payload?.code,
            LOBBY_ERROR_CODES.ROOM_CREATION_REQUIRES_TELEGRAM
        );
        assert.equal(harness.handoffStore.createCalls.length, 0);

        harness.authenticate("testnet-owner", 94002);
        const created = harness.createRoom("testnet-owner", {
            network: "mainnet",
            targetNetwork: "mainnet"
        });
        const roomId = created?.payload?.roomId;
        assert.ok(roomId);
        assert.equal(created.payload.network, "testnet");
        assert.equal(harness.bridge._roomNetworkByRoom.get(roomId), "testnet");

        harness.selectNetwork("testnet-owner", "mainnet");
        assert.equal(
            harness.socketDelivery("testnet-owner", LOBBY_SERVER_EVENTS.ROOM_ERROR)?.payload?.code,
            LOBBY_ERROR_CODES.ROOM_NETWORK_ALREADY_SELECTED
        );
        assert.equal(harness.handoffStore.createCalls.length, 0);
        assert.equal(harness.countDeliveries(LOBBY_SERVER_EVENTS.ROOM_NETWORK_HANDOFF_READY), 0);
        assert.equal(harness.roomManager.getActiveRoomCount(), 1);
        assert.equal(harness.bridge._roomNetworkByRoom.get(roomId), "testnet");
    } finally {
        harness.close();
    }
});
