import assert from "node:assert/strict";
import { test } from "node:test";
import { buildNativeGramRefundTransferPlan } from "../payment/refund/NativeGramRefundTransferPlan.js";

const source = "0:" + "a".repeat(64);
const payer = "0:" + "b".repeat(64);
const obligation = Object.freeze({
    obligationId: "refund_A", idempotencyKey: "TESTNET:intent:tx",
    networkName: "TESTNET", globalId: -3,
    denomination: "TON", refundDestination: payer,
    amountAtomic: 2_500_000_000
});
const quote = Object.freeze({
    networkName: "TESTNET", globalId: -3,
    obligationId: "refund_A", sourceWalletAddress: source,
    destinationAddress: payer, paidAmountAtomic: "2500000000",
    maxFeeAtomic: "10000000", finalized: true,
    estimateSource: "testnet-network-estimator"
});

test("native GRAM refund plan binds payer, Testnet, original stake, fee and net transfer", () => {
    const plan = buildNativeGramRefundTransferPlan({
        obligation, sourceWalletAddress: source, feeQuote: quote
    });
    assert.equal(plan.refundAmountAtomic, "2490000000");
    assert.equal(plan.reservedFeeAtomic, "10000000");
    assert.equal(plan.originalPaidAmountAtomic, "2500000000");
    assert.equal(plan.sendRemainingBalance, false);
    assert.equal(BigInt(plan.refundAmountAtomic) + BigInt(plan.reservedFeeAtomic),
        BigInt(plan.originalPaidAmountAtomic));
    assert.equal(Object.isFrozen(plan), true);
});

test("missing, stale and cross-wallet fee quotes never authorize a refund amount", () => {
    for (const bad of [
        null,
        { ...quote, globalId: -239 },
        { ...quote, networkName: "MAINNET" },
        { ...quote, sourceWalletAddress: payer },
        { ...quote, destinationAddress: source },
        { ...quote, obligationId: "other" },
        { ...quote, paidAmountAtomic: "1000000000" },
        { ...quote, maxFeeAtomic: "0" },
        { ...quote, maxFeeAtomic: "2500000000" },
        { ...quote, maxFeeAtomic: "2500000001" },
        { ...quote, maxFeeAtomic: "not_a_fee" },
        { ...quote, finalized: false },
        { ...quote, estimateSource: "hardcoded" }
    ]) {
        assert.throws(() => buildNativeGramRefundTransferPlan({
            obligation, sourceWalletAddress: source, feeQuote: bad
        }));
    }
    assert.throws(() => buildNativeGramRefundTransferPlan({
        obligation: { ...obligation, denomination: "GRAM_JETTON" },
        sourceWalletAddress: source, feeQuote: quote
    }));
});
