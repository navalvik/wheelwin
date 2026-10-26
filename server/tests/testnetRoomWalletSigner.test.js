import test from "node:test";
import assert from "node:assert/strict";
import { TestnetRoomWalletSigner } from "../payment/refund/TestnetRoomWalletSigner.js";
const from = "0:" + "b".repeat(64);
const to = "0:" + "a".repeat(64);
const descriptor = {
    networkName: "TESTNET", globalId: -3, from, to,
    amountAtomic: 1_000_000_000, idempotencyKey: "refund-1",
    obligationId: "obligation-1"
};
test("signer attests wallet identity with no embedded credentials", async () => {
    let count = 0;
    const signer = new TestnetRoomWalletSigner({
        walletPool: { listWallets: () => [{
            walletId: "wallet-37", roomNumber: 37, network: "testnet", address: from
        }] },
        signWithWallet: async request => {
            count++;
            assert.equal(request.walletId, "wallet-37");
            assert.equal(request.globalId, -3);
            return { sourceWalletAddress: from, boc: "te6ccgEBAQEAAgAAAA==" };
        }
    });
    assert.deepEqual(await signer.signTransfer(descriptor), { boc: "te6ccgEBAQEAAgAAAA==" });
    assert.equal(count, 1);
});
test("source mismatch or cross-network wallet prevents signing", async () => {
    let called = false;
    const signer = new TestnetRoomWalletSigner({
        walletPool: { listWallets: () => [{
            walletId: "wallet-37", roomNumber: 37, network: "mainnet", address: from
        }] },
        signWithWallet: async () => { called = true; }
    });
    await assert.rejects(signer.signTransfer(descriptor), /missing or ambiguous/);
    await assert.rejects(signer.signTransfer({ ...descriptor, globalId: -239 }), /invalid Testnet/);
    assert.equal(called, false);
});
test("signature response must attest exact source wallet", async () => {
    const signer = new TestnetRoomWalletSigner({
        walletPool: { listWallets: () => [{
            walletId: "wallet-37", roomNumber: 37, network: "testnet", address: from
        }] },
        signWithWallet: async () => ({ sourceWalletAddress: to, boc: "te6ccgEBAQEAAgAAAA==" })
    });
    await assert.rejects(signer.signTransfer(descriptor), /matching source identity/);
});
