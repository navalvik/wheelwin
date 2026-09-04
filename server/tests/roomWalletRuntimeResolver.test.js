import assert from "node:assert/strict";
import test from "node:test";

import {
    createRoomWalletRegistryFromEnv,
    createRoomWalletRuntimeResolver,
    loadRoomWalletRuntimeConfig
} from "../payment/roomWallet/RoomWalletRuntimeResolver.js";
import { createDummyRoomWalletEntry } from "./helpers/dummyRoomWallet.js";

function envWithWallets(wallets) {
    return {
        ROOM_WALLETS_JSON: JSON.stringify(wallets)
    };
}

test("Room Wallet runtime config is empty when no runtime secret configuration exists", () => {
    const config = loadRoomWalletRuntimeConfig({});
    assert.deepEqual(config.entries, []);
});

test("Room Wallet runtime resolver keeps signing material out of the registry", async () => {
    const wallet = createDummyRoomWalletEntry(1);
    const resolver = createRoomWalletRuntimeResolver({
        env: envWithWallets([wallet])
    });

    const identity = await resolver(1);
    const registry = createRoomWalletRegistryFromEnv(envWithWallets([wallet]));

    assert.equal(identity.roomNumber, 1);
    assert.equal(identity.workchain, 0);
    assert.equal(identity.publicKey.length, 32);
    assert.equal(identity.secretKey.length, 64);
    assert.equal(identity.address, wallet.address);
    assert.equal(registry.require(1).address, wallet.address);
    assert.equal(registry.require(1).publicKey, undefined);
    assert.equal(registry.require(1).secretKey, undefined);
});

test("Room Wallet runtime resolver rejects malformed signing material", () => {
    const wallet = createDummyRoomWalletEntry(1);
    assert.throws(
        () => loadRoomWalletRuntimeConfig(envWithWallets([{
            ...wallet,
            publicKey: "aa"
        }])),
        /publicKey.*32 bytes/
    );
});

test("Room Wallet registry rejects duplicate room mappings with different addresses", () => {
    const first = createDummyRoomWalletEntry(1);
    const second = createDummyRoomWalletEntry(2);

    assert.throws(
        () => createRoomWalletRegistryFromEnv(envWithWallets([
            first,
            { ...second, roomNumber: 1 }
        ])),
        /duplicate roomNumber 1/
    );
});
