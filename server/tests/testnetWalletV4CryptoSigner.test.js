import test from "node:test";
import assert from "node:assert/strict";
import { TestnetWalletV4CryptoSigner } from "../payment/refund/TestnetWalletV4CryptoSigner.js";

test("isolated WalletV4 signer requires protected key and seqno providers", () => {
    assert.throws(() => new TestnetWalletV4CryptoSigner(), /key resolver/);
});

test("invalid or Mainnet request fails before key access or crypto imports", async () => {
    let accessed = false;
    const signer = new TestnetWalletV4CryptoSigner({
        keyResolver: () => { accessed = true; throw new Error("must not read keys"); },
        seqnoProvider: () => { throw new Error("must not request seqno"); }
    });
    await assert.rejects(signer.signWithWallet({
        networkName: "MAINNET", globalId: -239, walletId: "wallet-1",
        from: "0:"+"b".repeat(64), to: "0:"+"a".repeat(64),
        amountAtomic: 1_000_000_000
    }), /Testnet WalletV4 signing request invalid/);
    assert.equal(accessed, false);
});
