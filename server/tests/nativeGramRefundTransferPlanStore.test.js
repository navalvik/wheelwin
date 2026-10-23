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

test("refund retry preserves original net amount without re-estimating changed network fees", async () => {
    const root = mkdtempSync(join(tmpdir(), "ww-refund-fee-retry-"));
    try {
        let estimateCalls = 0;
        const firstStore = new NativeGramRefundTransferPlanStore({ dataDir: root });
        const firstProvider = new TestnetOutgoingRefundProvider({
            globalId: -3,
            feeEstimator: { estimateRefundFee: async () => {
                estimateCalls += 1;
                return quote;
            } },
            refundPlanStore: firstStore
        });
        const initial = await firstProvider.reserveNativeGramRefundTransferPlan({
            obligation, sourceWalletAddress: source
        });
        assert.equal(initial.replay, false);
        assert.equal(estimateCalls, 1);
        const initialPlan = firstStore.get(obligation.obligationId);
        assert.equal(initialPlan.refundAmountAtomic, "2490000000");
        assert.equal(initialPlan.reservedFeeAtomic, "10000000");

        // A restarted runtime has a different fee quote, but the already
        // reserved transfer terms must remain immutable.
        const reopenedStore = new NativeGramRefundTransferPlanStore({ dataDir: root });
        const retryProvider = new TestnetOutgoingRefundProvider({
            globalId: -3,
            feeEstimator: { estimateRefundFee: async () => {
                estimateCalls += 1;
                return { ...quote, maxFeeAtomic: "20000000" };
            } },
            refundPlanStore: reopenedStore
        });
        const retried = await retryProvider.reserveNativeGramRefundTransferPlan({
            obligation, sourceWalletAddress: source
        });
        assert.equal(retried.replay, true);
        assert.equal(estimateCalls, 1, "retry must not consult network fee estimator");
        assert.deepEqual(reopenedStore.get(obligation.obligationId), initialPlan);
        assert.equal(retryProvider.canExecute(), false, "test has no signer or broadcaster");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("retry refuses durable refund plan indexed under a different obligation", async () => {
    let estimatorCalls = 0;
    let reserveCalls = 0;
    const foreignPlan = { ...plan(), obligationId: "another-refund" };
    const provider = new TestnetOutgoingRefundProvider({
        globalId: -3,
        feeEstimator: { estimateRefundFee: async () => {
            estimatorCalls += 1;
            return quote;
        } },
        refundPlanStore: {
            get: () => foreignPlan,
            reserve: () => { reserveCalls += 1; }
        }
    });
    await assert.rejects(
        provider.reserveNativeGramRefundTransferPlan({
            obligation, sourceWalletAddress: source
        }),
        /persisted refund fee plan conflicts with original payment identity/
    );
    assert.equal(estimatorCalls, 0);
    assert.equal(reserveCalls, 0);
});

test("retry rejects altered net refund, reserved fee or send-all mode before reserve", async () => {
    for (const mutation of [
        { refundAmountAtomic: "2490000001" },
        { reservedFeeAtomic: "10000001" },
        { sendRemainingBalance: true },
        { refundAmountAtomic: "0" },
        { reservedFeeAtomic: "not-a-number" }
    ]) {
        let reserveCalls = 0;
        const provider = new TestnetOutgoingRefundProvider({
            globalId: -3,
            feeEstimator: { estimateRefundFee: async () => {
                throw new Error("retry must not re-estimate");
            } },
            refundPlanStore: {
                get: () => ({ ...plan(), ...mutation }),
                reserve: () => { reserveCalls += 1; }
            }
        });
        await assert.rejects(
            provider.reserveNativeGramRefundTransferPlan({
                obligation, sourceWalletAddress: source
            }),
            /persisted refund fee plan conflicts with original payment identity/
        );
        assert.equal(reserveCalls, 0);
    }
});
