import test from "node:test";
import assert from "node:assert/strict";
import { keyPairFromSeed } from "@ton/crypto";
import { WalletContractV4 } from "@ton/ton";

import { createProtectedTestnetRoomWalletKeyResolver } from "../payment/refund/ProtectedTestnetRoomWalletKeys.js";

function fixture() {
    const entries = [];
    const wallets = [];
    for (let roomNumber = 1; roomNumber <= 64; roomNumber += 1) {
        const keys = keyPairFromSeed(Buffer.alloc(32, roomNumber));
        const address = WalletContractV4.create({
            workchain: 0,
            publicKey: keys.publicKey
        }).address.toString();
        entries.push({
            roomNumber,
            network: "testnet",
            address,
            publicKey: keys.publicKey.toString("hex"),
            secretKey: keys.secretKey.toString("hex")
        });
        wallets.push({
            walletId: `room-wallet-${roomNumber}`,
            roomNumber,
            address,
            workchain: 0,
            network: "testnet"
        });
    }
    const walletPool = {
        listWallets: () => wallets.map(item => ({ ...item })),
        getWallet: id => wallets.find(item => item.walletId === id) ?? null
    };
    return {
        entries,
        wallets,
        walletPool,
        env: { TON_NETWORK: "testnet", ROOM_WALLETS_JSON: JSON.stringify(entries) }
    };
}

test("restored Testnet resolver verifies and returns the registered WalletV4 key pair", async () => {
    const f = fixture();
    const resolve = createProtectedTestnetRoomWalletKeyResolver(f);
    const keys = await resolve("room-wallet-2");
    assert.equal(keys.publicKey.toString("hex"), f.entries[1].publicKey);
    assert.equal(keys.secretKey.toString("hex"), f.entries[1].secretKey);
    keys.secretKey.fill(0);
    assert.equal((await resolve("room-wallet-2")).secretKey.toString("hex"), f.entries[1].secretKey);
    await assert.rejects(resolve("room-wallet-65"), /missing/);
});

test("restored Testnet resolver refuses network switching and wrong public identities", () => {
    const f = fixture();
    assert.throws(
        () => createProtectedTestnetRoomWalletKeyResolver({ ...f, network: "mainnet" }),
        /Testnet only/
    );
    assert.throws(
        () => createProtectedTestnetRoomWalletKeyResolver({ ...f, env: { ...f.env, TON_NETWORK: "mainnet" } }),
        /Testnet only/
    );
    f.wallets[0].address = f.wallets[1].address;
    assert.throws(() => createProtectedTestnetRoomWalletKeyResolver(f), /registered wallet address/);
});

test("restored Testnet resolver rejects incorrect signing keys without exposing secrets", () => {
    const f = fixture();
    const secret = f.entries[0].secretKey;
    f.entries[0].secretKey = f.entries[1].secretKey;
    f.env.ROOM_WALLETS_JSON = JSON.stringify(f.entries);
    assert.throws(() => createProtectedTestnetRoomWalletKeyResolver(f), error => {
        assert.match(error.message, /key pair does not match/);
        assert.equal(error.message.includes(secret), false);
        return true;
    });
});

test("restored Testnet resolver rejects incomplete or ambiguous 64-wallet catalogs", () => {
    const f = fixture();
    f.entries.pop();
    f.env.ROOM_WALLETS_JSON = JSON.stringify(f.entries);
    assert.throws(() => createProtectedTestnetRoomWalletKeyResolver(f), /exactly 64/);

    const g = fixture();
    g.entries[1].roomNumber = 1;
    g.env.ROOM_WALLETS_JSON = JSON.stringify(g.entries);
    assert.throws(() => createProtectedTestnetRoomWalletKeyResolver(g), /room identity/);
});

test("restored Testnet resolver refuses wallet identity drift after construction", async () => {
    const f = fixture();
    const resolve = createProtectedTestnetRoomWalletKeyResolver(f);
    f.wallets[0].address = f.wallets[1].address;
    await assert.rejects(resolve("room-wallet-1"), /identity changed/);
});
