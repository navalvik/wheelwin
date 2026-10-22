/**
 * Normalize *candidate* GRAM jetton transfers from Toncenter v3.
 *
 * The indexer is a discovery source only. This mapper NEVER manufactures
 * "finalized", "VERIFIED_JETTON_TRANSFER", a payment reference or an authority
 * to settle. A distinct chain proof + decoded TEP-74 payload + durable
 * transaction claim must authorize subsequent settlement.
 */
import { tonAddressIdentityOrNull } from "../incoming/TonAddressIdentity.js";

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
    expectedAmountAtomic
} = {}) {
    const master = canonical(jettonMaster);
    const recipient = canonical(roomWallet);
    const sender = canonical(expectedSender);
    if (!master || !recipient || !sender || !positiveAtomicString(expectedAmountAtomic)) {
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
            || record.transaction_now <= 0) continue;
        const key = transactionKey(record);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        candidates.push(Object.freeze({
            transactionKey: key,
            transactionHash: record.transaction_hash.toLowerCase(),
            transactionLt: record.transaction_lt,
            transactionUtime: record.transaction_now,
            jettonMaster: master,
            sender,
            recipient,
            amountAtomic: record.amount,
            paymentReference: null,
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
