/**
 * Trusted boundary for player-funded TON network-fee evidence.
 *
 * This adapter is intentionally NOT wired into payment acceptance. It does not
 * treat caller-provided labels or `finalized: true` as evidence. It delegates
 * estimation and finalized transaction verification to injected server-only
 * providers, validates their returned identities, and constructs the records
 * consumed by the pure accounting policy.
 *
 * Production readiness requires concrete providers that independently query
 * the approved TON Testnet endpoint and verify source, destination, value,
 * transaction identity, wallet seqno, block inclusion, and finality. A stub or
 * caller-controlled provider is not a trust boundary.
 */
import { randomUUID } from "node:crypto";

export const PLAYER_FEE_EVIDENCE_NETWORK = Object.freeze({
    networkName: "TESTNET",
    globalId: -3,
    quoteSource: "TONCENTER_FEE_ESTIMATE"
});

export class PlayerFeeEvidenceBoundaryError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = "PlayerFeeEvidenceBoundaryError";
        this.code = "PLAYER_FEE_EVIDENCE_BOUNDARY_ERROR";
        this.details = Object.freeze({ ...details });
    }
}

function text(value, field) {
    if (typeof value !== "string" || value.trim() === "") {
        throw new PlayerFeeEvidenceBoundaryError(`${field} must be a non-empty string`, { field });
    }
    return value.trim();
}

function atomic(value, field, { positive = false } = {}) {
    if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) {
        throw new PlayerFeeEvidenceBoundaryError(`${field} must be a valid atomic integer`, { field });
    }
    return value;
}

function assertTestnetIdentity(result, description) {
    if (!result || result.networkName !== PLAYER_FEE_EVIDENCE_NETWORK.networkName
        || result.globalId !== PLAYER_FEE_EVIDENCE_NETWORK.globalId) {
        throw new PlayerFeeEvidenceBoundaryError(`${description} did not verify TON Testnet identity`);
    }
}

export class PlayerFeeEvidenceBoundary {
    constructor({ feeEstimator, finalizedTransferVerifier, now = () => Date.now(), idFactory = randomUUID } = {}) {
        if (typeof feeEstimator?.estimateOutgoingFee !== "function") {
            throw new PlayerFeeEvidenceBoundaryError("server-side fee estimator is required");
        }
        if (typeof finalizedTransferVerifier?.verifyFinalizedOutgoingTransfer !== "function") {
            throw new PlayerFeeEvidenceBoundaryError("finalized outgoing-transfer verifier is required");
        }
        if (typeof now !== "function" || typeof idFactory !== "function") {
            throw new PlayerFeeEvidenceBoundaryError("clock and ID factory must be functions");
        }
        this._feeEstimator = feeEstimator;
        this._finalizedTransferVerifier = finalizedTransferVerifier;
        this._now = now;
        this._idFactory = idFactory;
    }

    async createQuote({ operationId, sourceWalletAddress, destination, amountAtomic, purpose, body, validForMs }) {
        const request = Object.freeze({
            operationId: text(operationId, "operationId"),
            sourceWalletAddress: text(sourceWalletAddress, "sourceWalletAddress"),
            destination: text(destination, "destination"),
            amountAtomic: atomic(amountAtomic, "amountAtomic", { positive: true }),
            purpose: text(purpose, "purpose"),
            body: text(body, "body"),
            networkName: PLAYER_FEE_EVIDENCE_NETWORK.networkName,
            globalId: PLAYER_FEE_EVIDENCE_NETWORK.globalId
        });
        if (!Number.isSafeInteger(validForMs) || validForMs <= 0) {
            throw new PlayerFeeEvidenceBoundaryError("validForMs must be a positive safe integer");
        }

        const estimate = await this._feeEstimator.estimateOutgoingFee(request);
        assertTestnetIdentity(estimate, "fee estimator");
        const feeAtomic = atomic(estimate?.feeAtomic, "estimate.feeAtomic");
        const quotedAtMs = atomic(estimate?.quotedAtMs, "estimate.quotedAtMs");
        const nowMs = atomic(this._now(), "nowMs");
        if (quotedAtMs > nowMs || nowMs - quotedAtMs > validForMs) {
            throw new PlayerFeeEvidenceBoundaryError("fee estimator returned a stale or future quote");
        }
        if (estimate.source !== PLAYER_FEE_EVIDENCE_NETWORK.quoteSource
            || estimate.sourceWalletAddress !== request.sourceWalletAddress
            || estimate.destination !== request.destination
            || estimate.amountAtomic !== request.amountAtomic
            || estimate.purpose !== request.purpose) {
            throw new PlayerFeeEvidenceBoundaryError("fee estimate does not match the requested outgoing operation");
        }

        return Object.freeze({
            operationId: request.operationId,
            estimateId: text(estimate.estimateId ?? this._idFactory(), "estimateId"),
            sourceWalletAddress: request.sourceWalletAddress,
            destination: request.destination,
            amountAtomic: request.amountAtomic,
            purpose: request.purpose,
            body: request.body,
            networkName: PLAYER_FEE_EVIDENCE_NETWORK.networkName,
            globalId: PLAYER_FEE_EVIDENCE_NETWORK.globalId,
            source: PLAYER_FEE_EVIDENCE_NETWORK.quoteSource,
            feeAtomic,
            quotedAtMs,
            validForMs
        });
    }

    async verifyActualFee({ quote, transactionId, expectedSeqno }) {
        if (!quote || quote.networkName !== PLAYER_FEE_EVIDENCE_NETWORK.networkName
            || quote.globalId !== PLAYER_FEE_EVIDENCE_NETWORK.globalId
            || quote.source !== PLAYER_FEE_EVIDENCE_NETWORK.quoteSource) {
            throw new PlayerFeeEvidenceBoundaryError("a Testnet quote from the approved estimator boundary is required");
        }
        const normalizedTransactionId = text(transactionId, "transactionId");
        atomic(expectedSeqno, "expectedSeqno");
        const observed = await this._finalizedTransferVerifier.verifyFinalizedOutgoingTransfer({
            networkName: PLAYER_FEE_EVIDENCE_NETWORK.networkName,
            globalId: PLAYER_FEE_EVIDENCE_NETWORK.globalId,
            sourceWalletAddress: text(quote.sourceWalletAddress, "quote.sourceWalletAddress"),
            destination: text(quote.destination, "quote.destination"),
            amountAtomic: atomic(quote.amountAtomic, "quote.amountAtomic", { positive: true }),
            transactionId: normalizedTransactionId,
            expectedSeqno
        });
        assertTestnetIdentity(observed, "outgoing transaction verifier");
        if (observed.verified !== true || observed.finalized !== true
            || observed.transactionId !== normalizedTransactionId
            || observed.sourceWalletAddress !== quote.sourceWalletAddress
            || observed.destination !== quote.destination
            || observed.amountAtomic !== quote.amountAtomic
            || observed.seqno !== expectedSeqno) {
            throw new PlayerFeeEvidenceBoundaryError("outgoing transaction failed source/destination/value/seqno/finality verification");
        }
        const feeAtomic = atomic(observed.feeAtomic, "observed.feeAtomic");
        const observedAtMs = atomic(observed.observedAtMs, "observed.observedAtMs");
        const blockId = text(observed.blockId, "observed.blockId");
        return Object.freeze({
            operationId: quote.operationId,
            transactionId: normalizedTransactionId,
            sourceWalletAddress: quote.sourceWalletAddress,
            destination: quote.destination,
            amountAtomic: quote.amountAtomic,
            seqno: expectedSeqno,
            blockId,
            networkName: PLAYER_FEE_EVIDENCE_NETWORK.networkName,
            globalId: PLAYER_FEE_EVIDENCE_NETWORK.globalId,
            finalized: true,
            observedAtMs,
            feeAtomic
        });
    }
}
