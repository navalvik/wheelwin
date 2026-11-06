/**
 * Regression: R23 Mainnet bootstrap attempted .get() on an undefined map
 * before it could check a handoff or create an authoritative Mainnet room.
 *
 * Unlike legacy R20/R22 tests, this exercises only the still-present R23
 * runtime idempotency primitive. The network remains server-owned at CREATE_ROOM.
 */
import assert from "node:assert/strict";
import { RoomLobbyBridge } from "../socket/RoomLobbyBridge.js";

function makeBridge() {
    return new RoomLobbyBridge({
        logger: null,
        eventBus: null,
        roomManager: null,
        playerManager: null,
        telegramIdentityResolver: () => null
    });
}

const first = makeBridge();
assert.ok(first._roomNetworkHandoffRoomByHandoff instanceof Map,
    "Mainnet bootstrap idempotency map must exist before first request");
assert.equal(first._roomNetworkHandoffRoomByHandoff.size, 0);
assert.equal(first._roomNetworkHandoffRoomByHandoff.get("unused-handoff"), undefined);

first._roomNetworkHandoffRoomByHandoff.set("handoff-1", "mainnet-room-1");
assert.equal(first._roomNetworkHandoffRoomByHandoff.get("handoff-1"), "mainnet-room-1",
    "subsequent bootstrap retries must reuse the same authoritative room");

const second = makeBridge();
assert.ok(second._roomNetworkHandoffRoomByHandoff instanceof Map);
assert.equal(second._roomNetworkHandoffRoomByHandoff.size, 0,
    "new runtime may not inherit another instance's room associations");

first._roomNetworkHandoffRoomByHandoff.clear();
assert.equal(first._roomNetworkHandoffRoomByHandoff.size, 0,
    "terminal cleanup must be able to clear R23 state");

console.log("Mainnet R23 idempotency map regression passed");
