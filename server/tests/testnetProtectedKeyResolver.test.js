import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { keyPairFromSeed } from "@ton/crypto";
import { WalletContractV4 } from "@ton/ton";
import { createTestnetProtectedKeyResolver } from "../payment/refund/TestnetProtectedKeyResolver.js";
import { TestnetWalletV4CryptoSigner } from "../payment/refund/TestnetWalletV4CryptoSigner.js";

const pair = keyPairFromSeed(Buffer.alloc(32, 23));
const address = WalletContractV4.create({ workchain: 0, publicKey: pair.publicKey }).address.toRawString();
const catalog = Array.from({ length: 64 }, (_, i) => ({
    walletId: "wallet-" + (i + 1),
    roomNumber: i + 1,
    network: "testnet",
    address: i === 0 ? address : "0:" + (i + 1).toString(16).padStart(64, "0"),
    publicKey: pair.publicKey.toString("hex"),
    secretKey: pair.secretKey.toString("hex")
}));
const walletPool = { getWallet: id => id === "wallet-1"
    ? { walletId: id, roomNumber: 1, network: "testnet", address } : null };
test("private resolver reads only authorized wallet and signs a synthetic Testnet BOC", async () => {
    let reads = 0;
    const keyResolver = createTestnetProtectedKeyResolver({
        walletPool, secretProvider: () => { reads++; return JSON.stringify(catalog); }
    });
    assert.equal(reads, 0, "secret is never loaded during setup");
    const crypto = new TestnetWalletV4CryptoSigner({
        keyResolver, seqnoProvider: async () => 0
    });
    const signed = await crypto.signWithWallet({
        walletId: "wallet-1", from: address, to: "0:" + "a".repeat(64),
        amountAtomic: 1_000_000_000, globalId: -3, networkName: "TESTNET"
    });
    assert.ok(signed.boc.startsWith("te6cc"));
    assert.equal(reads, 1);
});
test("invalid secret catalog and mismatch fail without leaking any secret", async () => {
    for (const entries of [
        [],
        catalog.map(x => x.walletId === "wallet-1" ? { ...x, secretKey: "c".repeat(128) } : x),
        catalog.map(x => x.walletId === "wallet-1" ? { ...x, address: "0:" + "b".repeat(64) } : x),
        [...catalog.slice(0, 63), catalog[0]]
    ]) {
        const resolve = createTestnetProtectedKeyResolver({
            walletPool, secretProvider: () => JSON.stringify(entries)
        });
        await assert.rejects(resolve("wallet-1"), error => {
            assert.ok(!error.message.includes(pair.secretKey.toString("hex")));
            return true;
        });
    }
});
test("unknown wallet ID never reads secret provider", async () => {
    const resolve = createTestnetProtectedKeyResolver({
        walletPool, secretProvider: () => { throw Error("must not load secrets"); }
    });
    await assert.rejects(resolve("wallet-2"), /not registered/);
});
