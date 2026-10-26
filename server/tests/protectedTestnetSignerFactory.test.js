import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { keyPairFromSeed } from "@ton/crypto";
import { WalletContractV4 } from "@ton/ton";
import { createProtectedTestnetRoomWalletSigner } from "../payment/refund/ProtectedTestnetSignerFactory.js";
import { ToncenterTestnetRefundBroadcaster } from "../payment/refund/ToncenterTestnetRefundBroadcaster.js";

test("protected catalog through signed BOC to offline Testnet broadcaster", async () => {
    const pair = keyPairFromSeed(Buffer.alloc(32, 42));
    const address = WalletContractV4.create({
        workchain: 0, publicKey: pair.publicKey
    }).address.toRawString();
    const wallet = { walletId: "room-1", roomNumber: 1, network: "testnet", address };
    const catalog = Array.from({ length: 64 }, (_, i) => ({
        walletId: i === 0 ? "room-1" : "room-" + (i + 1),
        roomNumber: i + 1, network: "testnet",
        address: i === 0 ? address : "0:" + (i + 1).toString(16).padStart(64, "0"),
        publicKey: pair.publicKey.toString("hex"),
        secretKey: pair.secretKey.toString("hex")
    }));
    let secretReads = 0;
    const signer = createProtectedTestnetRoomWalletSigner({
        walletPool: {
            listWallets: () => [wallet],
            getWallet: id => id === wallet.walletId ? wallet : null
        },
        secretProvider: () => {
            secretReads++;
            return JSON.stringify(catalog);
        },
        seqnoProvider: async source => {
            assert.equal(source, address);
            return 0;
        }
    });
    assert.equal(secretReads, 0);
    const signedTransfer = await signer.signTransfer({
        networkName: "TESTNET", globalId: -3,
        from: address, to: "0:" + "a".repeat(64),
        amountAtomic: 1_000_000_000,
        idempotencyKey: "offline-1", obligationId: "offline-refund-1"
    });
    assert.equal(secretReads, 1);
    let posts = 0;
    const broadcaster = new ToncenterTestnetRefundBroadcaster({
        apiKeyProvider: () => "offline-key",
        fetchImpl: async (_url, options) => {
            posts++;
            assert.equal(JSON.parse(options.body).boc, signedTransfer.boc);
            return { ok: true, status: 200, json: async () => ({ ok: true }) };
        }
    });
    const result = await broadcaster.broadcast({ signedTransfer });
    assert.equal(posts, 1);
    assert.equal(result.status, "UNKNOWN", "broadcast acknowledgement is not finality");
});

test("without secret provider protected signing stays disabled", () => {
    assert.throws(() => createProtectedTestnetRoomWalletSigner({
        walletPool: { listWallets: () => [], getWallet: () => null },
        seqnoProvider: async () => 0
    }), /secret and seqno providers/);
});
