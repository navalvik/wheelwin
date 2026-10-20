import test from "node:test";
import assert from "node:assert/strict";
import {
    PlayerFeeEvidenceBoundary,
    PlayerFeeEvidenceBoundaryError
} from "../payment/fees/PlayerFeeEvidenceBoundary.js";

const request = {
    operationId: "winner-payout",
    sourceWalletAddress: "room-wallet",
    destination: "winner-wallet",
    amountAtomic: 1_000_000_000,
    purpose: "WINNER_PAYOUT",
    validForMs: 60_000
};

function makeBoundary({ estimateOverrides = {}, observedOverrides = {} } = {}) {
    return new PlayerFeeEvidenceBoundary({
        now: () => 10_000,
        idFactory: () => "estimate-fixed",
        feeEstimator: {
            async estimateOutgoingFee(input) {
                return {
                    networkName: "TESTNET",
                    globalId: -3,
                    sourceWalletAddress: input.sourceWalletAddress,
                    destination: input.destination,
                    amountAtomic: input.amountAtomic,
                    purpose: input.purpose,
                    feeAtomic: 100,
                    quotedAtMs: 9_000,
                    estimateId: "provider-estimate-1",
                    ...estimateOverrides
                };
            }
        },
        finalizedTransferVerifier: {
            async verifyFinalizedOutgoingTransfer(input) {
                return {
                    networkName: "TESTNET",
                    globalId: -3,
                    verified: true,
                    finalized: true,
                    sourceWalletAddress: input.sourceWalletAddress,
                    destination: input.destination,
                    amountAtomic: input.amountAtomic,
                    transactionId: input.transactionId,
                    seqno: input.expectedSeqno,
                    blockId: "0:master:123",
                    observedAtMs: 9_900,
                    feeAtomic: 90,
                    ...observedOverrides
                };
            }
        }
    });
}

test("quote is reconstructed from server-side estimate with fixed Testnet identity", async () => {
    const boundary = makeBoundary();
    const quote = await boundary.createQuote(request);
    assert.equal(quote.networkName, "TESTNET");
    assert.equal(quote.globalId, -3);
    assert.equal(quote.source, "TONCENTER_FEE_ESTIMATE");
    assert.equal(quote.estimateId, "provider-estimate-1");
    assert.equal(quote.sourceWalletAddress, "room-wallet");
    assert.equal(quote.feeAtomic, 100);
});

test("quote rejects estimator identity mismatch", async () => {
    const boundary = makeBoundary({ estimateOverrides: { globalId: 0 } });
    await assert.rejects(() => boundary.createQuote(request), PlayerFeeEvidenceBoundaryError);
});

test("quote rejects estimates for a different destination or amount", async () => {
    const wrongDestination = makeBoundary({ estimateOverrides: { destination: "attacker-wallet" } });
    await assert.rejects(() => wrongDestination.createQuote(request), PlayerFeeEvidenceBoundaryError);
    const wrongAmount = makeBoundary({ estimateOverrides: { amountAtomic: 7 } });
    await assert.rejects(() => wrongAmount.createQuote(request), PlayerFeeEvidenceBoundaryError);
});

test("actual fee requires verified finality and exact source, destination, amount, transaction, and seqno", async () => {
    const boundary = makeBoundary();
    const quote = await boundary.createQuote(request);
    const actual = await boundary.verifyActualFee({ quote, transactionId: "tx-123", expectedSeqno: 44 });
    assert.equal(actual.transactionId, "tx-123");
    assert.equal(actual.seqno, 44);
    assert.equal(actual.feeAtomic, 90);
    assert.equal(actual.finalized, true);
});

test("caller-controlled finalized flag cannot override verifier rejection", async () => {
    const boundary = makeBoundary({ observedOverrides: { verified: false, finalized: true } });
    const quote = await boundary.createQuote(request);
    await assert.rejects(
        () => boundary.verifyActualFee({ quote, transactionId: "tx-123", expectedSeqno: 44 }),
        PlayerFeeEvidenceBoundaryError
    );
});

test("outgoing transaction mismatch and wrong network fail closed", async () => {
    const wrongTx = makeBoundary({ observedOverrides: { transactionId: "different-tx" } });
    const quote = await wrongTx.createQuote(request);
    await assert.rejects(
        () => wrongTx.verifyActualFee({ quote, transactionId: "tx-123", expectedSeqno: 44 }),
        PlayerFeeEvidenceBoundaryError
    );

    const wrongNetwork = makeBoundary({ observedOverrides: { networkName: "MAINNET" } });
    const quote2 = await wrongNetwork.createQuote(request);
    await assert.rejects(
        () => wrongNetwork.verifyActualFee({ quote: quote2, transactionId: "tx-123", expectedSeqno: 44 }),
        PlayerFeeEvidenceBoundaryError
    );
});
