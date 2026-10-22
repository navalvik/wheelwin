import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildNativeGramRefundTransferPlan } from "../payment/refund/NativeGramRefundTransferPlan.js";
import { NativeGramRefundTransferPlanStore } from "../payment/refund/NativeGramRefundTransferPlanStore.js";
import { TestnetOutgoingRefundProvider } from "../payment/refund/TestnetOutgoingRefundProvider.js";

const source = "0:" + "a".repeat(64);
const payer = "0:" + "b".repeat(64);
const obligation = Object.freeze({
    obligationId: "refund-persist-a", idempotencyKey: "TESTNET:payment:tx",
    networkName: "TESTNET", globalId: -3,
    denomination: "TON", refundDestination: payer,
    amountAtomic: 2_500_000_000
});
const quote = Object.freeze({
    networkName: "TESTNET", globalId: -3, obligationId: obligation.obligationId,
    sourceWalletAddress: source, destinationAddress: payer,
    paidAmountAtomic: "2500000000", maxFeeAtomic: "10000000",
    finalized: true, estimateSource: "testnet-network-estimator"
});
const plan = () => buildNativeGramRefundTransferPlan({
    obligation, sourceWalletAddress: source, feeQuote: quote
});

test("fee-bound native GRAM refund persists and reopens identically without a signer", () => {
    const root = mkdtempSync(join(tmpdir(), "ww-refund-plans-"));
    try {
        const first = new NativeGramRefundTransferPlanStore({ dataDir: root });
        assert.equal(first.get(obligation.obligationId), null);
        assert.equal(first.reserve(plan()).replay, false);
        const second = new NativeGramRefundTransferPlanStore({ dataDir: root });
        assert.deepEqual(second.get(obligation.obligationId), plan());
        assert.equal(second.reserve(plan()).replay, true);
        assert.throws(() => second.reserve({
            ...plan(), refundAmountAtomic: "2480000000",
            reservedFeeAtomic: "20000000"
        }), /DIFFERENT_TERMS/);
        assert.deepEqual(first.get(obligation.obligationId), plan());
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("malformed, cross-network and inconsistent refund plan never reaches disk", () => {
    const root = mkdtempSync(join(tmpdir(), "ww-refund-plans-"));
    try {
        const store = new NativeGramRefundTransferPlanStore({ dataDir: root });
        for (const patch of [
            { globalId: -239 }, { networkName: "MAINNET" },
            { denomination: "JETTON" }, { sendRemainingBalance: true },
            { refundAmountAtomic: "2500000000" },
            { sourceWalletAddress: payer }, { refundDestination: source },
            { reservedFeeAtomic: "0" }, { unexpected: "do not accept" }
        ]) {
            assert.throws(() => store.reserve({ ...plan(), ...patch }));
        }
        assert.equal(store.get(obligation.obligationId), null);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("provider only reserves estimate with exact identity and never enables execution", async () => {
    const root = mkdtempSync(join(tmpdir(), "ww-refund-plans-"));
    try {
        const store = new NativeGramRefundTransferPlanStore({ dataDir: root });
        const provider = new TestnetOutgoingRefundProvider({
            globalId: -3,
            feeEstimator: { estimateRefundFee: async () => quote },
            refundPlanStore: store
        });
        assert.equal((await provider.reserveNativeGramRefundTransferPlan({
            obligation, sourceWalletAddress: source
        })).replay, false);
        assert.equal((await provider.reserveNativeGramRefundTransferPlan({
            obligation, sourceWalletAddress: source
        })).replay, true);
        assert.equal(provider.canExecute(), false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
