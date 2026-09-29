import assert from "node:assert/strict";
import test from "node:test";

import { createRoomWalletService } from "../payment/roomWallet/RoomWalletService.js";
import {
    createDummyRoomWalletCatalog,
    createDummyRoomWalletEntry
} from "./helpers/dummyRoomWallet.js";

const WALLET = createDummyRoomWalletEntry(1);
const ADDRESS = WALLET.address;

function env() {
    return {
        TON_NETWORK: "testnet",
        ROOM_WALLETS_JSON: JSON.stringify(createDummyRoomWalletCatalog())
    };
}

test("Room Wallet service composes registry, resolver, transport and settlement adapter", () => {
    const tonService = {};
    const service = createRoomWalletService({ tonService, env: env() });

    assert.equal(service.registry.size(), 64);
    assert.equal(service.registry.require(1).address, ADDRESS);
    assert.equal(typeof service.walletResolver, "function");
    assert.equal(typeof service.roomWalletAdapter.getBalance, "function");
    assert.equal(typeof service.roomWalletAdapter.sendTransfer, "function");
    assert.equal(typeof service.settlementAdapter.settleContract, "function");
    assert.equal(service.isConfigured(), true);
});

test("Room Wallet service fails closed when runtime wallet configuration is absent", () => {
    assert.throws(
        () => createRoomWalletService({ tonService: {}, env: {} }),
        /TON_NETWORK must be explicitly set/
    );
});
