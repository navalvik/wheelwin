import assert from "node:assert/strict";
import test from "node:test";

import {
    createRoomWalletRegistryFromEnv,
    createRoomWalletRuntimeResolver,
    loadRoomWalletRuntimeConfig
} from "../payment/roomWallet/RoomWalletRuntimeResolver.js";
import { createDummyRoomWalletEntry } from "./helpers/dummyRoomWallet.js";

function catalog() {
    return Array.from({ length: 64 }, (_, index) =>
        createDummyRoomWalletEntry(index + 1)
    );
}

function envWithWallets(wallets, network = "testnet") {
    return {
        TON_NETWORK: network,
        ROOM_WALLETS_JSON: JSON.stringify(wallets)
    };
}

test("Room Wallet runtime config fails closed when the catalog is missing", () => {
    assert.throws(
        () => loadRoomWalletRuntimeConfig({ TON_NETWORK: "testnet" }),
        /ROOM_WALLETS_TESTNET_JSON.*required.*testnet.*ROOM_WALLETS_JSON.*compatibility/i
    );
});

test("Room Wallet runtime config requires exactly 64 Testnet wallets", () => {
    assert.throws(
        () => loadRoomWalletRuntimeConfig(
            envWithWallets(catalog().slice(0, 63))
        ),
        /exactly 64 wallets/
    );
});

test("Room Wallet runtime resolver keeps signing material out of the registry", async () => {
    const wallets = catalog();
    const resolver = createRoomWalletRuntimeResolver({
        env: envWithWallets(wallets)
    });

    const identity = await resolver(1);
    const registry = createRoomWalletRegistryFromEnv(envWithWallets(wallets));

    assert.equal(identity.roomNumber, 1);
    assert.equal(identity.workchain, 0);
    assert.equal(identity.publicKey.length, 32);
    assert.equal(identity.secretKey.length, 64);
    assert.equal(identity.address, wallets[0].address);
    assert.equal(registry.require(1).address, wallets[0].address);
    assert.equal(registry.require(1).publicKey, undefined);
    assert.equal(registry.require(1).secretKey, undefined);
});

test("Room Wallet runtime resolver rejects malformed signing material", () => {
    const wallets = catalog();
    wallets[0] = {
        ...wallets[0],
        publicKey: "aa"
    };

    assert.throws(
        () => loadRoomWalletRuntimeConfig(envWithWallets(wallets)),
        /publicKey.*32 bytes/
    );
});

test("Room Wallet registry rejects duplicate room mappings", () => {
    const wallets = catalog();
    wallets[1] = {
        ...wallets[1],
        roomNumber: 1
    };

    assert.throws(
        () => createRoomWalletRegistryFromEnv(envWithWallets(wallets)),
        /duplicate roomNumber 1/
    );
});

test("Mainnet never falls back to the Testnet ROOM_WALLETS_JSON variable", () => {
    assert.throws(
        () => loadRoomWalletRuntimeConfig({
            TON_NETWORK: "mainnet",
            ROOM_WALLETS_JSON: JSON.stringify(catalog())
        }),
        /ROOM_WALLETS_MAINNET_JSON.*required/
    );
});
