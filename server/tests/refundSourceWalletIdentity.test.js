import test from "node:test";
import assert from "node:assert/strict";

import { TestnetOutgoingRefundProvider } from "../payment/refund/TestnetOutgoingRefundProvider.js";
import { buildTestnetOutgoingRefundProvider } from "../payment/runtime/PaymentRuntimeFactory.js";

const PAYER = "0:" + "a".repeat(64);
const ROOM_WALLET = "0:" + "b".repeat(64);
const OTHER_WALLET = "0:" + "c".repeat(64);

function fixture() {
    const wallet = { walletId: "wallet-1", roomNumber: 1, network: "testnet", address: ROOM_WALLET };
    const walletPool = {
        getWallet: id => id === wallet.walletId ? wallet : null,
        listWallets: () => [wallet]
    };
    const obligation = {
        networkName: "TESTNET", globalId: -3, roomNumber: 1,
        obligationId: "refund-1", idempotencyKey: "idempotent-refund-1",
        paymentIntentId: "payment-1", roomId: "room-1", playerId: "bob",
        denomination: "TON", amountAtomic: 1_000_000_000,
        refundDestination: PAYER
    };
    const intent = {
        paymentReference: "payment-1", roomId: "room-1", playerId: "bob",
        network: "testnet", asset: "TON", state: "SETTLED",
        expectedSender: PAYER, destinationWalletId: "wallet-1",
        destinationWalletAddress: ROOM_WALLET
    };
    const intentStore = { require: () => intent };
    const provider = new TestnetOutgoingRefundProvider({ globalId: -3, walletPool });
    return { wallet, walletPool, obligation, intent, intentStore, provider };
}

test("durable refund resolves only the room wallet registered to the same Testnet room", () => {
    const f = fixture();
    assert.equal(f.provider.resolveSourceWallet({
        obligation: f.obligation, intentStore: f.intentStore
    }), ROOM_WALLET);
});

test("wrong payment identity or non-settled intent cannot authorize refund source", () => {
    const f = fixture();
    const variants = [
        { paymentReference: "payment-elsewhere" },
        { roomId: "room-elsewhere" },
        { playerId: "alice" },
        { network: "mainnet" },
        { asset: "GRAM_JETTON" },
        { state: "MATCHED" },
        { expectedSender: OTHER_WALLET },
        { destinationWalletAddress: "invalid" }
    ];
    for (const changes of variants) {
        assert.throws(() => f.provider.resolveSourceWallet({
            obligation: f.obligation,
            intentStore: { require: () => ({ ...f.intent, ...changes }) }
        }), /durable payment intent/);
    }
});

test("mismatched wallet id, room number, network or address fails before signing", () => {
    const f = fixture();
    assert.throws(() => f.provider.resolveSourceWallet({
        obligation: f.obligation,
        intentStore: { require: () => ({ ...f.intent, destinationWalletId: "unknown" }) }
    }), /authoritative Testnet pool/);
    for (const changes of [
        { roomNumber: 2 }, { network: "mainnet" },
        { address: OTHER_WALLET }, { walletId: "another-wallet" }
    ]) {
        const provider = new TestnetOutgoingRefundProvider({
            globalId: -3,
            walletPool: {
                getWallet: () => ({ ...f.wallet, ...changes }),
                listWallets: () => [{ ...f.wallet, ...changes }]
            }
        });
        assert.throws(() => provider.resolveSourceWallet({
            obligation: f.obligation, intentStore: f.intentStore
        }), /authoritative Testnet pool/);
    }
});

test("direct refund broadcast cannot bypass the room wallet source check", async () => {
    const f = fixture();
    let signed = 0, broadcast = 0;
    const provider = new TestnetOutgoingRefundProvider({
        globalId: -3, walletPool: f.walletPool,
        signer: { signTransfer: () => { signed++; return { boc: "unused" }; } },
        broadcaster: { broadcast: () => { broadcast++; return { status: "UNKNOWN" }; } },
        finalityEvidenceProvider: { getSettlementEvidence: async () => null },
        outgoingTransferProvider: {
            getOutgoingTransfer: async () => null,
            findOutgoingTransfer: async () => null
        }
    });
    await assert.rejects(provider.signAndBroadcast({
        obligation: f.obligation, sourceWalletAddress: OTHER_WALLET, nowMs: 1
    }), /authoritative room wallet/);
    assert.equal(signed, 0);
    assert.equal(broadcast, 0);
});

test("production refund provider factory retains the authoritative wallet pool", () => {
    const f = fixture();
    const provider = buildTestnetOutgoingRefundProvider({
        globalId: -3, walletPool: f.walletPool,
        finalityEvidenceProvider: { getSettlementEvidence: async () => null },
        submitter: {
            signer: { signTransfer: async () => null },
            broadcaster: { broadcast: async () => null },
            outgoingTransferProvider: {
                getOutgoingTransfer: async () => null,
                findOutgoingTransfer: async () => null
            }
        }
    });
    assert.equal(provider?.canExecute(), true);
    assert.throws(() => provider.resolveSourceWallet({
        obligation: f.obligation,
        intentStore: { require: () => ({ ...f.intent, destinationWalletId: "unknown" }) }
    }), /authoritative Testnet pool/);
});
