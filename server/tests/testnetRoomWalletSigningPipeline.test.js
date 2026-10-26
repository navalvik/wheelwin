import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { keyPairFromSeed } from "@ton/crypto";
import { WalletContractV4 } from "@ton/ton";
import { Cell } from "@ton/core";
import { TestnetRoomWalletSigner } from "../payment/refund/TestnetRoomWalletSigner.js";
import { TestnetWalletV4CryptoSigner } from "../payment/refund/TestnetWalletV4CryptoSigner.js";

test("pool wallet -> protected crypto callback -> signed BOC, no network", async () => {
    const pair = keyPairFromSeed(Buffer.alloc(32, 19));
    const address = WalletContractV4.create({ workchain: 0, publicKey: pair.publicKey })
        .address.toRawString();
    const cryptoSigner = new TestnetWalletV4CryptoSigner({
        keyResolver: async (walletId) => {
            assert.equal(walletId, "synthetic-room-37");
            return pair;
        },
        seqnoProvider: async (source) => {
            assert.equal(source, address);
            return 0;
        }
    });
    const signer = new TestnetRoomWalletSigner({
        walletPool: {
            listWallets: () => [{
                walletId: "synthetic-room-37", roomNumber: 37,
                network: "testnet", address
            }]
        },
        signWithWallet: request => cryptoSigner.signWithWallet(request)
    });
    const { boc } = await signer.signTransfer({
        networkName: "TESTNET", globalId: -3, from: address,
        to: "0:" + "a".repeat(64), amountAtomic: 1_000_000_000,
        obligationId: "synthetic-refund", idempotencyKey: "test-only"
    });
    assert.equal(Cell.fromBoc(Buffer.from(boc, "base64")).length, 1);
});

test("crypto signer cannot substitute a different pool wallet key", async () => {
    const expectedPair = keyPairFromSeed(Buffer.alloc(32, 19));
    const wrongPair = keyPairFromSeed(Buffer.alloc(32, 20));
    const address = WalletContractV4.create({
        workchain: 0, publicKey: expectedPair.publicKey
    }).address.toRawString();
    const signer = new TestnetRoomWalletSigner({
        walletPool: {
            listWallets: () => [{
                walletId: "synthetic-room-37", roomNumber: 37,
                network: "testnet", address
            }]
        },
        signWithWallet: new TestnetWalletV4CryptoSigner({
            keyResolver: async () => wrongPair,
            seqnoProvider: async () => 0
        }).signWithWallet.bind(new TestnetWalletV4CryptoSigner({
            keyResolver: async () => wrongPair,
            seqnoProvider: async () => 0
        }))
    });
    await assert.rejects(signer.signTransfer({
        networkName: "TESTNET", globalId: -3, from: address,
        to: "0:" + "a".repeat(64), amountAtomic: 1_000_000_000,
        obligationId: "synthetic-refund", idempotencyKey: "test-only"
    }), /signing key does not match authoritative room wallet/);
});
