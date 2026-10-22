import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyPlannedNativeGramRefundFinality } from "../payment/refund/OutgoingRefundFinality.js";
import { TestnetOutgoingRefundProvider } from "../payment/refund/TestnetOutgoingRefundProvider.js";

const NOW = 1800000000000;
const source = "0:" + "a".repeat(64);
const payer = "0:" + "b".repeat(64);
const txId = "outgoing-verified-tx";
const obligation = {
    obligationId: "refund_a", idempotencyKey: "TESTNET:reference:incoming",
    networkName: "TESTNET", globalId: -3, denomination: "TON",
    refundDestination: payer, amountAtomic: 2_500_000_000,
    outgoingTransactionId: txId, finalizedEvidence: null
};
const plan = {
    obligationId: obligation.obligationId,
    idempotencyKey: obligation.idempotencyKey,
    networkName: "TESTNET", globalId: -3,
    sourceWalletAddress: source, refundDestination: payer,
    originalPaidAmountAtomic: "2500000000", refundAmountAtomic: "2490000000",
    reservedFeeAtomic: "10000000", denomination: "TON", sendRemainingBalance: false
};
const block = { workchain: 0, shard: "8000000000000000", seqno: 10 };
const evidence = {
    networkIdentity: {
        network: "testnet", globalId: -3,
        source: "toncenter-masterchain-info", observedAtMs: NOW
    },
    transactionInclusion: { transactionId: txId, accountId: source, block },
    finality: {
        status: "finalized", source: "toncenter-streaming-v2",
        transactionId: txId, accountId: source, block,
        masterchainSeqno: 11, observedAtMs: NOW
    }
};
const outgoingTransfer = {
    transactionId: txId, sourceAddress: source,
    destinationAddress: payer, amountAtomic: 2_490_000_000
};
const check = (overrides = {}) =>
    verifyPlannedNativeGramRefundFinality({
        obligation, plan, sourceWalletAddress: source,
        outgoingTransactionId: txId, evidence, outgoingTransfer, nowMs: NOW,
        ...overrides
    });

test("finality proof matches the NET player transfer rather than gross principal", () => {
    const verified = check();
    assert.equal(verified.verified, true);
    assert.equal(verified.refundAmountAtomic, "2490000000");
    assert.equal(verified.reservedFeeAtomic, "10000000");
    assert.equal(verified.originalPaidAmountAtomic, "2500000000");
    assert.equal(verified.finalizedEvidence, undefined,
        "advisory verifier must not construct a legacy gross refund completion record");
});

test("gross-amount payout, wrong destination, wrong source or missing finality fail", () => {
    for (const overrides of [
        { outgoingTransfer: { ...outgoingTransfer, amountAtomic: 2_500_000_000 } },
        { outgoingTransfer: { ...outgoingTransfer, destinationAddress: source } },
        { outgoingTransfer: { ...outgoingTransfer, sourceAddress: payer } },
        { outgoingTransfer: null },
        { evidence: null },
        { evidence: { ...evidence, finality: { ...evidence.finality, status: "pending" } } },
        { outgoingTransactionId: "another-tx" },
        { plan: { ...plan, globalId: -239 } },
        { plan: { ...plan, reservedFeeAtomic: "20000000" } },
        { plan: { ...plan, refundAmountAtomic: "2495000000" } },
        { plan: { ...plan, sendRemainingBalance: true } }
    ]) assert.equal(check(overrides).verified, false);
});

test("Testnet provider observes immutable stored NET plan without broadcasting", async () => {
    let reads = 0;
    const provider = new TestnetOutgoingRefundProvider({
        globalId: -3,
        refundPlanStore: { get(id) {
            assert.equal(id, obligation.obligationId);
            return plan;
        } },
        finalityEvidenceProvider: { async getSettlementEvidence() {
            reads++;
            return evidence;
        } },
        outgoingTransferProvider: { async getOutgoingTransfer() {
            reads++;
            return outgoingTransfer;
        } }
    });
    const result = await provider.observeAndVerifyPlannedNativeGramRefund({
        obligation, sourceWalletAddress: source,
        outgoingTransactionId: txId, nowMs: NOW
    });
    assert.equal(result.verified, true);
    assert.equal(reads, 2);
    assert.equal(provider.canExecute(), false,
        "read-only finality never enables automatic refunds");
    await assert.rejects(
        new TestnetOutgoingRefundProvider({ globalId: -3 })
            .observeAndVerifyPlannedNativeGramRefund({
                obligation, sourceWalletAddress: source,
                outgoingTransactionId: txId, nowMs: NOW
            }), /plan store is unavailable/
    );
});
