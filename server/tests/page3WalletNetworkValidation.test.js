import test from "node:test";
import assert from "node:assert/strict";
import { Address } from "@ton/core";
import { RoomLobbyBridge } from "../socket/RoomLobbyBridge.js";

const account = new Address(0, Buffer.alloc(32, 0x4d));
const friendly = (options) => account.toString({ urlSafe: true, ...options });
const MAINNET_EQ = friendly({ bounceable: true, testOnly: false });
const MAINNET_UQ = friendly({ bounceable: false, testOnly: false });
const TESTNET_KQ = friendly({ bounceable: true, testOnly: true });
const TESTNET_0Q = friendly({ bounceable: false, testOnly: true });

function makeBridge(network = "mainnet") {
    const errors = [];
    const updates = [];
    const confirmed = new Map();
    const bridge = {
        _assertAuthoritativeMutation: () => ({ roomId: "room-page3", playerId: "player-1" }),
        _roomManager: { getRoom: () => ({ players: ["player-1", "player-2", "player-3"] }) },
        _playerManager: {
            updateIdentity: (playerId, patch) => updates.push({ playerId, patch })
        },
        _continueToVerifyByRoom: new Set(),
        _roomNetworkByRoom: new Map([["room-page3", network]]),
        _page3WalletNetworkByRoom: new Map(),
        _verifyConfirmedByRoom: confirmed,
        _profilesRevealedByRoom: new Set(),
        _emitRoomError: (socketId, code) => errors.push({ socketId, code }),
        _deliverToSocket: () => {},
        _buildPlayerList: () => [],
        _logger: { info: () => {} }
    };
    return { bridge, errors, updates, confirmed };
}

test("Mainnet Page3 accepts EQ/UQ and rejects test-only, bad checksum and malformed addresses", () => {
    for (const wallet of [MAINNET_EQ, MAINNET_UQ]) {
        const state = makeBridge("mainnet");
        RoomLobbyBridge.prototype._handleUpdatePlayerProfile.call(
            state.bridge, "socket-1", { wallet }
        );
        assert.equal(state.updates.length, 1);
        assert.equal(state.bridge._page3WalletNetworkByRoom.get("room-page3")
            .get("player-1"), "mainnet");
        assert.equal(state.errors.length, 0);
    }

    const badChecksum = `${MAINNET_EQ.slice(0, -1)}${MAINNET_EQ.endsWith("A") ? "B" : "A"}`;
    for (const wallet of [TESTNET_0Q, TESTNET_KQ, badChecksum, "not-a-ton-address"]) {
        const state = makeBridge("mainnet");
        RoomLobbyBridge.prototype._handleUpdatePlayerProfile.call(
            state.bridge, "socket-1", { wallet }
        );
        assert.equal(state.updates.length, 0, wallet);
        assert.equal(state.errors.length, 1, wallet);
    }
});

test("direct Mainnet confirmVerify cannot bypass Page3 wallet network validation", () => {
    const state = makeBridge("mainnet");
    RoomLobbyBridge.prototype._handleConfirmVerify.call(state.bridge, "socket-1");
    assert.equal(state.confirmed.has("room-page3"), false);
    assert.equal(state.errors.length, 1);

    RoomLobbyBridge.prototype._handleUpdatePlayerProfile.call(
        state.bridge, "socket-1", { wallet: TESTNET_0Q }
    );
    RoomLobbyBridge.prototype._handleConfirmVerify.call(state.bridge, "socket-1");
    assert.equal(state.confirmed.has("room-page3"), false);
    assert.equal(state.errors.length, 3);
});

test("a valid Mainnet wallet permits server VERIFY; Testnet address behavior stays unchanged", () => {
    const mainnet = makeBridge("mainnet");
    RoomLobbyBridge.prototype._handleUpdatePlayerProfile.call(
        mainnet.bridge, "socket-1", { wallet: MAINNET_EQ }
    );
    RoomLobbyBridge.prototype._handleConfirmVerify.call(mainnet.bridge, "socket-1");
    assert.equal(mainnet.confirmed.get("room-page3")?.has("player-1"), true);
    assert.equal(mainnet.errors.length, 0);

    const testnet = makeBridge("testnet");
    RoomLobbyBridge.prototype._handleUpdatePlayerProfile.call(
        testnet.bridge, "socket-1", { wallet: `0:${"a".repeat(64)}` }
    );
    RoomLobbyBridge.prototype._handleConfirmVerify.call(testnet.bridge, "socket-1");
    assert.equal(testnet.confirmed.get("room-page3")?.has("player-1"), true);
    assert.equal(testnet.errors.length, 0);
});
