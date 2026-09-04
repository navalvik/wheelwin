import assert from "node:assert/strict";
import test from "node:test";

import {
    createRoomWalletRegistryFromEnv,
    createRoomWalletRuntimeResolver,
    loadRoomWalletRuntimeConfig
} from "../payment/roomWallet/RoomWalletRuntimeResolver.js";

const PUBLIC_KEY = "11".repeat(32);
const SECRET_KEY = "22".repeat(64);

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
    const resolver = createRoomWalletRuntimeResolver({
        env: envWithWallets([{
            roomNumber: 1,
            address: "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c",
            publicKey: PUBLIC_KEY,
            secretKey: SECRET_KEY,
            workchain: 0,
            network: "testnet"
        }])
    });

    const identity = await resolver(1);

    assert.equal(identity.roomNumber, 1);
    assert.equal(identity.workchain, 0);
    assert.equal(identity.publicKey.length, 32);
    assert.equal(identity.secretKey.length, 64);
});

test("Room Wallet runtime resolver rejects malformed signing material", () => {
    assert.throws(
        () => loadRoomWalletRuntimeConfig(envWithWallets([{
            roomNumber: 1,
            address: "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c",
            publicKey: "aa",
            secretKey: SECRET_KEY
        }])),
        /publicKey.*32 bytes/
    );
});

test("Room Wallet registry rejects duplicate room mappings with different addresses", () => {
    assert.throws(
        () => createRoomWalletRegistryFromEnv(envWithWallets([
            {
                roomNumber: 1,
                address: "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c",
                publicKey: PUBLIC_KEY,
                secretKey: SECRET_KEY
            },
            {
                roomNumber: 1,
                address: "EQBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
                publicKey: PUBLIC_KEY,
                secretKey: SECRET_KEY
            }
        ])),
        /already mapped/
    );
});
