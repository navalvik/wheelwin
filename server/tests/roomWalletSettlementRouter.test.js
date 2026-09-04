import assert from "node:assert/strict";
import test from "node:test";

import { RoomWalletSettlementRouter } from "../payment/RoomWalletSettlementRouter.js";

function adapter(name) {
    return {
        async settleContract(request) {
            return { adapter: name, request };
        },
        async getSettlementState(address) {
            return { adapter: name, address };
        }
    };
}

test("RoomWalletSettlementRouter uses legacy adapter by default", async () => {
    const legacy = adapter("legacy");
    const roomWallet = adapter("room-wallet");
    const router = new RoomWalletSettlementRouter({
        legacySettlementAdapter: legacy,
        roomWalletSettlementAdapter: roomWallet
    });

    const result = await router.settleContract({ gameId: "g1" });

    assert.equal(router.isEnabled(), false);
    assert.equal(result.adapter, "legacy");
});

test("RoomWalletSettlementRouter switches explicitly to Room Wallet adapter", async () => {
    const router = new RoomWalletSettlementRouter({
        legacySettlementAdapter: adapter("legacy"),
        roomWalletSettlementAdapter: adapter("room-wallet")
    });

    router.setEnabled(true);

    const result = await router.settleContract({
        gameId: "g2",
        winnerWallet: "winner",
        ownerWallet: "owner"
    });

    assert.equal(router.isEnabled(), true);
    assert.equal(result.adapter, "room-wallet");
    assert.equal(result.request.gameId, "g2");
});

test("RoomWalletSettlementRouter routes state probes through the active adapter", async () => {
    const router = new RoomWalletSettlementRouter({
        legacySettlementAdapter: adapter("legacy"),
        roomWalletSettlementAdapter: adapter("room-wallet"),
        enabled: true
    });

    const result = await router.getSettlementState("room-wallet-address");

    assert.equal(result.adapter, "room-wallet");
    assert.equal(result.address, "room-wallet-address");
});
