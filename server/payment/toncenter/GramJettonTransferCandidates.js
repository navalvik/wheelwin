/**
 * Normalize *candidate* GRAM jetton transfers from Toncenter v3.
 *
 * The indexer is a discovery source only. This mapper NEVER manufactures
 * "finalized", "VERIFIED_JETTON_TRANSFER", a payment reference or an authority
 * to settle. A distinct chain proof + decoded TEP-74 payload + durable
 * transaction claim must authorize subsequent settlement.
 */
import { tonAddressIdentityOrNull } from "../incoming/TonAddressIdentity.js";
import { isPaymentReference } from "../incoming/PaymentReferenceCodec.js";
import { matchGramReferenceHint } from "./GramJettonReferenceHints.js";

function canonical(value) {
    return tonAddressIdentityOrNull(value);
}

function positiveAtomicString(value) {
    return typeof value === "string" && /^[1-9][0-9]*$/.test(value);
}

function transactionKey(transfer) {
    if (typeof transfer.transaction_hash !== "string"
        || !/^[a-fA-F0-9]{64}$/.test(transfer.transaction_hash)
        || typeof transfer.transaction_lt !== "string"
        || !/^[1-9][0-9]*$/.test(transfer.transaction_lt)) return null;
    return `${transfer.transaction_hash.toLowerCase()}:${transfer.transaction_lt}`;
}

/**
 * Expected sender/recipient are OWNER wallet identities (not jetton contracts).
 * A matching result is still unverified and cannot be credited.
 */
export function mapGramJettonCandidates(discovery, {
    jettonMaster,
    roomWallet,
    expectedSender,
    expectedAmountAtomic,
    expectedPaymentReference,
    startUtime,
    endUtime
} = {}) {
    const master = canonical(jettonMaster);
    const recipient = canonical(roomWallet);
    const sender = canonical(expectedSender);
    if (!master || !recipient || !sender || !positiveAtomicString(expectedAmountAtomic)
        || !isPaymentReference(expectedPaymentReference)
        || (startUtime !== undefined && (!Number.isSafeInteger(startUtime) || startUtime < 0))
        || (endUtime !== undefined && (!Number.isSafeInteger(endUtime) || endUtime < 0))
        || (startUtime !== undefined && endUtime !== undefined && startUtime > endUtime)) {
        throw new Error("Invalid authoritative GRAM candidate filter");
    }
    if (!discovery || !Array.isArray(discovery.transfers)
        || discovery.finalized !== false || discovery.verifiedForSettlement !== false) {
        throw new Error("Only explicitly unverified Toncenter discovery can be mapped");
    }

    const candidates = [];
    const seen = new Set();
    for (const record of discovery.transfers) {
        if (!record || typeof record !== "object" || Array.isArray(record)
            || record.transaction_aborted !== false
            || canonical(record.jetton_master) !== master
            || canonical(record.destination) !== recipient
            || canonical(record.source) !== sender
            || !positiveAtomicString(record.amount)
            || record.amount !== expectedAmountAtomic
            || !Number.isSafeInteger(record.transaction_now)
            || record.transaction_now <= 0
            || (startUtime !== undefined && record.transaction_now < startUtime)
            || (endUtime !== undefined && record.transaction_now > endUtime)) continue;
        // A candidate is meaningless for a player without an exact intent
        // reference; do not admit sender/amount-only collisions.
        const referenceHint = matchGramReferenceHint(record, expectedPaymentReference);
        if (!referenceHint.matched) continue;
        // Finality is observed on a Jetton Wallet CONTRACT account, not on
        // the owner wallet in destination/source. Keep the indexed contract
        // identity for a subsequent independent finalized-transaction check.
        const sourceJettonWallet = canonical(record.source_wallet);
        if (!sourceJettonWallet) continue;
        // Toncenter trace_id links the surrounding message cascade, but an
        // indexer-supplied ID is only a lookup key, NEVER proof of delivery.
        const traceId = typeof record.trace_id === "string" && /^[a-fA-F0-9]{64}$/.test(record.trace_id)
            ? record.trace_id.toLowerCase() : null;
        if (!traceId) continue;
        const key = transactionKey(record);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        candidates.push(Object.freeze({
            transactionKey: key,
            transactionHash: record.transaction_hash.toLowerCase(),
            transactionLt: record.transaction_lt,
            transactionUtime: record.transaction_now,
            sourceJettonWallet,
            traceId,
            jettonMaster: master,
            sender,
            recipient,
            amountAtomic: record.amount,
            paymentReference: null,
            referenceHintMatched: referenceHint?.matched === true,
            finalized: false,
            verifiedForSettlement: false
        }));
    }
    return Object.freeze({
        candidates: Object.freeze(candidates),
        complete: discovery.truncated === false,
        verifiedForSettlement: false
    });
}
