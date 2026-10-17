/**
 * Outgoing refund finality evidence verifier (TON Testnet only).
 *
 * The outgoing refund path is the mirror image of the incoming settlement
 * path: money that LEFT the room wallet and must be proven finalized before a
 * refund obligation may be marked COMPLETE. This module performs ONLY the
 * evidence/authorization decision. It does not sign, broadcast, persist or
 * mutate anything, exposes no secrets, and never manufactures provider
 * evidence — it verifies evidence another layer independently produced.
 *
 * It reuses the shared, structural `assessTonPaymentSettlementEvidence` policy
 * (Testnet global ID -3, inclusion bound to the queried account + transaction
 * hash, `finalized` status, fresh timestamp) and the provider-independent TON
 * address identity, then adds the outgoing-specific checks the incoming policy
 * deliberately does not make:
 *
 *   - the observed message actually originated from the expected SOURCE wallet;
 *   - it paid the expected refund DESTINATION (the verified payer);
 *   - it carried the exact refunded ATOMIC amount;
 *   - its transaction identity equals the recorded outgoing transaction;
 *   - no conflicting evidence is already bound to the obligation.
 *
 * An API acknowledgement, a bare transaction row, or an ambiguous/unsettled
 * response can never pass: only a policy-authorized, finalized package that
 * matches the outgoing refund identity returns `verified: true`.
 */

import {
    assessTonPaymentSettlementEvidence,
    TON_TESTNET_GLOBAL_ID
} from "../incoming/TonPaymentSettlementEvidence.js";
import {
    deriveTonAddressIdentity,
    tonAddressIdentitiesEqual,
    tonAddressIdentityOrNull
} from "../incoming/TonAddressIdentity.js";
import { REFUND_NETWORK } from "./RefundObligation.js";

/** Precise, non-secret rejection reasons for outgoing refund finality. */
export const OUTGOING_FINALITY_REJECTION = Object.freeze({
    MALFORMED_EVIDENCE: "MALFORMED_EVIDENCE",
    MISSING_TRANSACTION_IDENTITY: "MISSING_TRANSACTION_IDENTITY",
    NETWORK_IDENTITY_CONFLICT: "NETWORK_IDENTITY_CONFLICT",
    TRANSACTION_INCLUSION_MISMATCH: "TRANSACTION_INCLUSION_MISMATCH",
    FINALITY_UNVERIFIED: "FINALITY_UNVERIFIED",
    EVIDENCE_STALE: "EVIDENCE_STALE",
    OUTGOING_TRANSFER_NOT_OBSERVED: "OUTGOING_TRANSFER_NOT_OBSERVED",
    UNRELATED_TRANSACTION: "UNRELATED_TRANSACTION",
    SENDER_MISMATCH: "SENDER_MISMATCH",
    RECIPIENT_MISMATCH: "RECIPIENT_MISMATCH",
    AMOUNT_MISMATCH: "AMOUNT_MISMATCH",
    OBLIGATION_NETWORK_UNSUPPORTED: "OBLIGATION_NETWORK_UNSUPPORTED",
    EVIDENCE_CONFLICTS_WITH_OBLIGATION: "EVIDENCE_CONFLICTS_WITH_OBLIGATION"
});

function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Rebuild the finalized-evidence record persisted on the obligation. It carries
 * ONLY the non-secret fields the obligation schema allows and always mirrors
 * the obligation's own network identity (a provider's lowercase "testnet" is
 * never copied into the obligation's "TESTNET" networkName).
 */
function buildFinalizedEvidence({ obligation, outgoingTransactionId, evidence, nowMs }) {
    const block = evidence.transactionInclusion.block;
    const blockId = `0:${String(block.shard)}:${String(block.seqno)}`;
    return Object.freeze({
        networkName: obligation.networkName,
        globalId: obligation.globalId,
        transactionId: outgoingTransactionId,
        amountAtomic: obligation.amountAtomic,
        destination: obligation.refundDestination,
        finalized: true,
        observedAtMs: nowMs,
        blockId
    });
}

/**
 * Verify independently-produced outgoing refund evidence before it is allowed
 * to complete an obligation.
 *
 * @param {{
 *   obligation: import("./RefundObligation.js").RefundObligation,
 *   sourceWalletAddress: string,
 *   outgoingTransactionId: string,
 *   evidence: object|null,
 *   outgoingTransfer: object|null,
 *   nowMs: number
 * }} params
 * @returns {{ verified: true, finalizedEvidence: object }
 *   | { verified: false, reason: string }}
 */
export function verifyOutgoingRefundFinality({
    obligation,
    sourceWalletAddress,
    outgoingTransactionId,
    evidence,
    outgoingTransfer,
    nowMs
}) {
    // The obligation is a settled, Testnet-only refund target.
    if (!obligation
        || obligation.networkName !== REFUND_NETWORK.TESTNET
        || obligation.globalId !== TON_TESTNET_GLOBAL_ID) {
        return Object.freeze({ verified: false, reason: OUTGOING_FINALITY_REJECTION.OBLIGATION_NETWORK_UNSUPPORTED });
    }

    // A completed obligation can never be re-bound to different evidence, and
    // a recorded outgoing transaction identity can never be replaced.
    if (obligation.finalizedEvidence) {
        return Object.freeze({ verified: false, reason: OUTGOING_FINALITY_REJECTION.EVIDENCE_CONFLICTS_WITH_OBLIGATION });
    }
    if (obligation.outgoingTransactionId
        && obligation.outgoingTransactionId !== outgoingTransactionId) {
        return Object.freeze({ verified: false, reason: OUTGOING_FINALITY_REJECTION.EVIDENCE_CONFLICTS_WITH_OBLIGATION });
    }

    // The outgoing transaction identity is mandatory and must itself be well-formed.
    if (typeof outgoingTransactionId !== "string" || outgoingTransactionId.trim() === "") {
        return Object.freeze({ verified: false, reason: OUTGOING_FINALITY_REJECTION.MISSING_TRANSACTION_IDENTITY });
    }

    // The source wallet identity must be a valid TON address (fail closed).
    const sourceIdentity = tonAddressIdentityOrNull(sourceWalletAddress);
    if (sourceIdentity === null) {
        return Object.freeze({ verified: false, reason: OUTGOING_FINALITY_REJECTION.SENDER_MISMATCH });
    }

    // Shared structural finality policy: Testnet global ID -3, inclusion bound
    // to the queried source account + this transaction hash, `finalized`
    // status under the documented provider, and a fresh timestamp. A missing or
    // ambiguous package can only fail here — it is never acceptance.
    const policy = assessTonPaymentSettlementEvidence(evidence ?? {}, {
        transactionId: outgoingTransactionId,
        accountId: sourceWalletAddress,
        nowMs
    });
    if (!policy.authorized) {
        return Object.freeze({ verified: false, reason: policy.reason });
    }

    // The independently observed outgoing message. Without it neither the
    // recipient nor the amount can be certified, so finality is not proven.
    if (!isRecord(outgoingTransfer)) {
        return Object.freeze({ verified: false, reason: OUTGOING_FINALITY_REJECTION.OUTGOING_TRANSFER_NOT_OBSERVED });
    }
    if (typeof outgoingTransfer.transactionId !== "string"
        || outgoingTransfer.transactionId !== outgoingTransactionId) {
        return Object.freeze({ verified: false, reason: OUTGOING_FINALITY_REJECTION.UNRELATED_TRANSACTION });
    }
    if (!tonAddressIdentitiesEqual(outgoingTransfer.sourceAddress, sourceWalletAddress)) {
        return Object.freeze({ verified: false, reason: OUTGOING_FINALITY_REJECTION.SENDER_MISMATCH });
    }
    if (!tonAddressIdentitiesEqual(outgoingTransfer.destinationAddress, obligation.refundDestination)) {
        return Object.freeze({ verified: false, reason: OUTGOING_FINALITY_REJECTION.RECIPIENT_MISMATCH });
    }
    if (!Number.isSafeInteger(outgoingTransfer.amountAtomic)
        || outgoingTransfer.amountAtomic !== obligation.amountAtomic) {
        return Object.freeze({ verified: false, reason: OUTGOING_FINALITY_REJECTION.AMOUNT_MISMATCH });
    }

    return Object.freeze({
        verified: true,
        finalizedEvidence: buildFinalizedEvidence({
            obligation, outgoingTransactionId, evidence, nowMs
        }),
        sourceIdentity
    });
}
