import test from "node:test";
import assert from "node:assert/strict";
import { RoomWalletAdapter } from "../payment/roomWallet/RoomWalletAdapter.js";
import { createLegacyRoomWalletIdentityResolver } from "../payment/refund/LegacyRoomWalletIdentityBridge.js";

const wallet = {
    walletId: "testnet-room-1", roomNumber: 1, network: "testnet",
    address: "0:" + "a".repeat(64), workchain: 0
};
const keypair = { publicKey: Buffer.alloc(32, 1), secretKey: Buffer.alloc(64, 2) };

test("original room wallet adapter reads current 64-wallet registry through compatibility bridge", async () => {
    const requests = [];
    const tonService = {
        async getBalance(address) {
            requests.push(address);
            return 1_000_000_000n;
        }
    };
    const walletResolver = createLegacyRoomWalletIdentityResolver({
        walletPool: {
            listWallets: () => [wallet],
            getWallet: id => id === wallet.walletId ? wallet : null
        },
        keyResolver: async id => {
            assert.equal(id, wallet.walletId);
            return keypair;
        }
    });
    const adapter = new RoomWalletAdapter({ tonService, walletResolver });
    assert.equal(await adapter.getBalance(1), 1_000_000_000n);
    assert.deepEqual(requests, [wallet.address]);
});

test("original transfer refuses insufficient funds without signing or broadcasting", async () => {
    let broadcasts = 0;
    const adapter = new RoomWalletAdapter({
        tonService: {
            getBalance: async () => 0n,
            getSeqno: async () => 0,
            broadcastTransaction: async () => { broadcasts++; throw new Error("unexpected broadcast"); }
        },
        walletResolver: async () => ({
            ...wallet, publicKey: keypair.publicKey, secretKey: keypair.secretKey
        }),
        gasReserveNano: 0n
    });
    const outcome = await adapter.sendTransfer({
        roomNumber: 1,
        destination: "0:" + "b".repeat(64),
        amountNano: 1_000_000_000n
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, "INSUFFICIENT_BALANCE");
    assert.equal(broadcasts, 0);
});
