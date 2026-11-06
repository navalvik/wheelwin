/**
 * R20 — room network belongs to the selected server runtime at CREATE_ROOM.
 * Legacy post-create client selection remains a fail-closed no-op.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
    LOBBY_ERROR_CODES,
    LOBBY_SERVER_EVENTS
} from "../socket/lobbyProtocol.js";
import { createServerOwnedRoomNetworkHarness } from "./helpers/serverOwnedRoomNetworkHarness.js";

test("Telegram authentication gates room creation and server runtime owns network", () => {
    const harness = createServerOwnedRoomNetworkHarness({ network: "mainnet" });
    try {
        const denied = harness.createRoom("anonymous", {
            network: "testnet",
            telegramUserId: 91001,
            targetNetwork: "testnet"
        });
        assert.equal(denied, null);
        assert.equal(
            harness.socketDelivery("anonymous", LOBBY_SERVER_EVENTS.ROOM_ERROR)?.payload?.code,
            LOBBY_ERROR_CODES.ROOM_CREATION_REQUIRES_TELEGRAM
        );
        assert.equal(harness.roomManager.getActiveRoomCount(), 0);
        assert.equal(harness.playerManager.getDebugSnapshot().players.length, 0);

        harness.authenticate("owner-a", 91001);
        const created = harness.createRoom("owner-a", {
            network: "testnet",
            targetNetwork: "testnet",
            ownerTelegramUserId: 123456
        });
        const roomId = created?.payload?.roomId;
        assert.ok(roomId);
        assert.equal(created.payload.network, "mainnet");
        assert.equal(harness.bridge._roomNetworkByRoom.get(roomId), "mainnet");
        assert.equal(harness.roomDelivery(roomId, LOBBY_SERVER_EVENTS.ROOM_STATE)?.payload?.network, "mainnet");
    } finally {
        harness.close();
    }
});

test("client selection and forged room fields cannot override or cross room networks", () => {
    const harness = createServerOwnedRoomNetworkHarness({ network: "testnet" });
    try {
        harness.authenticate("owner-a", 92001);
        const roomA = harness.createRoom("owner-a")?.payload?.roomId;
        harness.authenticate("owner-b", 92002);
        const roomB = harness.createRoom("owner-b")?.payload?.roomId;
        assert.ok(roomA && roomB && roomA !== roomB);
        assert.equal(harness.bridge._roomNetworkByRoom.get(roomA), "testnet");
        assert.equal(harness.bridge._roomNetworkByRoom.get(roomB), "testnet");

        harness.selectNetwork("owner-a", "mainnet", {
            roomId: roomB,
            playerId: "forged-player",
            ownerPlayerId: "forged-owner",
            telegramUserId: 1,
            targetNetwork: "mainnet"
        });
        assert.equal(
            harness.socketDelivery("owner-a", LOBBY_SERVER_EVENTS.ROOM_ERROR)?.payload?.code,
            LOBBY_ERROR_CODES.ROOM_NETWORK_ALREADY_SELECTED
        );
        assert.equal(harness.bridge._roomNetworkByRoom.get(roomA), "testnet");
        assert.equal(harness.bridge._roomNetworkByRoom.get(roomB), "testnet");
        assert.equal(harness.countDeliveries(LOBBY_SERVER_EVENTS.ROOM_NETWORK_SELECTED), 0);
        assert.equal(harness.roomManager.getActiveRoomCount(), 2,
            "network selection attempts must never create duplicate rooms");
    } finally {
        harness.close();
    }
});

test("only the owner can issue legacy selection requests and identity is immutable", () => {
    const harness = createServerOwnedRoomNetworkHarness({ network: "mainnet" });
    try {
        harness.authenticate("owner", 93001);
        const roomId = harness.createRoom("owner")?.payload?.roomId;
        assert.ok(roomId);

        harness.authenticate("joiner", 93002);
        harness.joinRoom("joiner", roomId);
        assert.ok(harness.socketDelivery("joiner", LOBBY_SERVER_EVENTS.ROOM_JOINED));
        harness.selectNetwork("joiner", "testnet");
        assert.equal(
            harness.socketDelivery("joiner", LOBBY_SERVER_EVENTS.ROOM_ERROR)?.payload?.code,
            LOBBY_ERROR_CODES.ROOM_NETWORK_SELECT_FORBIDDEN
        );

        harness.selectNetwork("owner", "polygon");
        assert.equal(
            harness.socketDelivery("owner", LOBBY_SERVER_EVENTS.ROOM_ERROR)?.payload?.code,
            LOBBY_ERROR_CODES.ROOM_NETWORK_INVALID
        );
        harness.selectNetwork("owner", "testnet");
        assert.equal(
            harness.socketDelivery("owner", LOBBY_SERVER_EVENTS.ROOM_ERROR)?.payload?.code,
            LOBBY_ERROR_CODES.ROOM_NETWORK_ALREADY_SELECTED
        );
        assert.equal(harness.bridge._roomNetworkByRoom.get(roomId), "mainnet");
        assert.equal(harness.countDeliveries(LOBBY_SERVER_EVENTS.ROOM_NETWORK_SELECTED), 0);
        assert.equal(harness.roomManager.getActiveRoomCount(), 1);

        harness.selectNetwork("unbound-socket", "mainnet");
        assert.ok(harness.socketDelivery("unbound-socket", LOBBY_SERVER_EVENTS.ROOM_ERROR),
            "unbound mutation requests fail closed");
    } finally {
        harness.close();
    }
});
