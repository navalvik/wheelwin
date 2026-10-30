/**
 * Minimal settlement evidence policy for native TON Testnet payments.
 *
 * Policy: authorize only a fresh evidence package that identifies Testnet by
 * the TON masterchain global id (-3), binds the evidence to the exact queried
 * account and transaction hash, records that transaction in a block, and says
 * `finalized` under TON Center Streaming API v2 semantics. TON Center defines
 * finalized as committed in the masterchain and no longer subject to
 * invalidation. This module validates the contract; it does not manufacture
 * provider evidence or establish its provenance. Source semantics are
 * documented at https://docs.ton.org/api/streaming/overview and
 * https://docs.ton.org/api/streaming/reference.
 */

import { PaymentValidationError } from "../PaymentErrors.js";

export const TON_TESTNET_GLOBAL_ID = -3;

export const TON_SETTLEMENT_EVIDENCE_POLICY = Object.freeze({
    id: "ton-testnet-masterchain-finalized-v1",
    maxAgeMs: 30_000,
    network: "testnet",
    globalId: TON_TESTNET_GLOBAL_ID,
    finality: "finalized"
});

/** Narrow provider capability. It verifies evidence; it cannot mutate payments. */
export class TonPaymentSettlementEvidenceProvider {
    async getSettlementEvidence(_query) {
        throw new PaymentValidationError(
            "getSettlementEvidence must be implemented by the evidence provider"
        );
    }
}

function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Check evidence against a settlement candidate. This is deliberately a
 * structural policy check only; the observation service separately binds
 * accepted evidence to its exact provider-produced result using module-private
 * object identity.
 */
export function assessTonPaymentSettlementEvidence(
    evidence,
    { transactionId, accountId, nowMs }
) {
    if (!isRecord(evidence)
        || !isRecord(evidence.networkIdentity)
        || !isRecord(evidence.transactionInclusion)
        || !isRecord(evidence.finality)
        || typeof transactionId !== "string"
        || typeof accountId !== "string"
        || !Number.isSafeInteger(nowMs)) {
        return Object.freeze({ authorized: false, reason: "MALFORMED_EVIDENCE" });
    }

    const { networkIdentity, transactionInclusion, finality } = evidence;
    if (networkIdentity.globalId !== TON_TESTNET_GLOBAL_ID
        || networkIdentity.network !== "testnet"
        || networkIdentity.source !== "toncenter-masterchain-info"
        || !Number.isSafeInteger(networkIdentity.observedAtMs)) {
        return Object.freeze({ authorized: false, reason: "NETWORK_IDENTITY_UNVERIFIED" });
    }

    if (transactionInclusion.transactionId !== transactionId
        || transactionInclusion.accountId !== accountId
        || !isRecord(transactionInclusion.block)
        || !Number.isSafeInteger(transactionInclusion.block.workchain)
        || typeof transactionInclusion.block.shard !== "string"
        || transactionInclusion.block.shard.trim() === ""
        || !Number.isSafeInteger(transactionInclusion.block.seqno)
        || transactionInclusion.block.seqno < 0) {
        return Object.freeze({ authorized: false, reason: "TRANSACTION_INCLUSION_MISMATCH" });
    }

    if (!["toncenter-streaming-v2", "toncenter-indexed-v3-masterchain"]
            .includes(finality.source)
        || finality.status !== "finalized"
        || finality.transactionId !== transactionId
        || finality.accountId !== accountId
        || !isRecord(finality.block)
        || finality.block.workchain !== transactionInclusion.block.workchain
        || finality.block.shard !== transactionInclusion.block.shard
        || finality.block.seqno !== transactionInclusion.block.seqno
        || !Number.isSafeInteger(finality.masterchainSeqno)
        || finality.masterchainSeqno < 0
        || !Number.isSafeInteger(finality.observedAtMs)) {
        return Object.freeze({ authorized: false, reason: "FINALITY_UNVERIFIED" });
    }

    const timestamps = [networkIdentity.observedAtMs, finality.observedAtMs];
    if (timestamps.some((timestamp) => timestamp > nowMs
        || nowMs - timestamp > TON_SETTLEMENT_EVIDENCE_POLICY.maxAgeMs)) {
        return Object.freeze({ authorized: false, reason: "EVIDENCE_STALE" });
    }

    return Object.freeze({
        authorized: true,
        policyId: TON_SETTLEMENT_EVIDENCE_POLICY.id
    });
}

/** Validate evidence and throw a payment-domain error when it cannot authorize settlement. */
export function assertTonPaymentSettlementEvidence(evidence, context) {
    const decision = assessTonPaymentSettlementEvidence(evidence, context);
    if (!decision.authorized) {
        throw new PaymentValidationError(
            `TON settlement evidence rejected: ${decision.reason}`,
            { reason: decision.reason }
        );
    }
    return decision;
}
