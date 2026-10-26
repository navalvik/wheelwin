import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { keyPairFromSeed } from "@ton/crypto";
import { WalletContractV4 } from "@ton/ton";
import { Cell } from "@ton/core";
import { TestnetWalletV4CryptoSigner } from "../payment/refund/TestnetWalletV4CryptoSigner.js";

test("signs real Wallet V4R2 external BOC with synthetic seed only", async () => {
    const pair = keyPairFromSeed(Buffer.alloc(32, 7));
    const wallet = WalletContractV4.create({ workchain: 0, publicKey: pair.publicKey });
    const signer = new TestnetWalletV4CryptoSigner({
        keyResolver: async id => {
            assert.equal(id, "synthetic-wallet");
            return pair;
        },
        seqnoProvider: async () => 0
    });
    const result = await signer.signWithWallet({
        walletId: "synthetic-wallet", networkName: "TESTNET", globalId: -3,
        from: wallet.address.toRawString(), to: "0:" + "a".repeat(64),
        amountAtomic: 1_000_000_000
    });
    assert.equal(result.sourceWalletAddress, wallet.address.toRawString());
    const cells = Cell.fromBoc(Buffer.from(result.boc, "base64"));
    assert.equal(cells.length, 1);
    assert.ok(cells[0].hash().length === 32);
});
