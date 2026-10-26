import test from "node:test";
import assert from "node:assert/strict";
import { createLegacyRoomWalletIdentityResolver } from "../payment/refund/LegacyRoomWalletIdentityBridge.js";

const publicWallet = Object.freeze({
    walletId: "wallet-1", roomNumber: 1, network: "testnet",
    address: "0:" + "a".repeat(64), workchain: 0
});
const pair = { publicKey: Buffer.alloc(32, 1), secretKey: Buffer.alloc(64, 2) };

test("restored RoomWalletAdapter resolver shape uses existing pool identity", async () => {
    let requested = null;
    const resolve = createLegacyRoomWalletIdentityResolver({
        walletPool: {
            listWallets: () => [publicWallet],
            getWallet: id => id === publicWallet.walletId ? publicWallet : null
        },
        keyResolver: async id => { requested = id; return pair; }
    });
    const result = await resolve(1);
    assert.equal(requested, "wallet-1");
    assert.equal(result.address, publicWallet.address);
    assert.equal(result.roomNumber, 1);
    assert.equal(result.secretKey, pair.secretKey);
});

test("refuses ambiguous room wallet mapping before reading private keys", async () => {
    let reads = 0;
    const resolve = createLegacyRoomWalletIdentityResolver({
        walletPool: { listWallets: () => [publicWallet, publicWallet], getWallet: () => publicWallet },
        keyResolver: async () => { reads++; return pair; }
    });
    await assert.rejects(resolve(1), /missing or ambiguous/);
    assert.equal(reads, 0);
});

test("refuses missing wallet and wrong room number", async () => {
    const resolve = createLegacyRoomWalletIdentityResolver({
        walletPool: { listWallets: () => [], getWallet: () => null },
        keyResolver: async () => pair
    });
    await assert.rejects(resolve(1), /missing or ambiguous/);
    await assert.rejects(resolve(65), /invalid Testnet room wallet number/);
});
