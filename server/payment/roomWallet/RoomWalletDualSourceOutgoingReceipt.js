/**
 * Read-only TWO-source proof of an outgoing native GRAM transfer.
 *
 * Scope: wallet transactions fetched separately from TonAPI and TonCenter v3
 * for the SAME Room Wallet. A recipient/amount match alone is NOT sufficient
 * to attribute a payout to a room, since the same three test wallets may play
 * again. Require either an exact known source-wallet transaction receipt
 * (legacy reconciliation) or an immutable outgoing intent message hash.
 *
 * This module never signs, broadcasts, creates refunds, or releases wallets.
 */
import { Address } from "@ton/core";
import {
    normalizeTonTransactionHash,
    RoomWalletEvidenceUnavailable
} from "./RoomWalletDualSourceEvidence.js";

function raw(value) {
    const text = typeof value === "string"
        ? value : value?.address ?? value?.account_address ?? null;
    try {
        return typeof text === "string" ? Address.parse(text).toRawString().toLowerCase() : null;
    } catch {
        return null;
    }
}

function nano(value) {
    try {
        if (typeof value === "number" && !Number.isSafeInteger(value)) return null;
        const n = BigInt(value);
        return n > 0n ? n.toString(10) : null;
    } catch {
        return null;
    }
}

function validLt(value) {
    const text = String(value ?? "");
    return /^\d+$/.test(text) ? BigInt(text).toString() : null;
}

function normalizeOutgoing(tx, expectedAccount) {
    const lt = validLt(tx?.lt ?? tx?.transaction_id?.lt);
    const hash = normalizeTonTransactionHash(tx?.hash ?? tx?.transaction_id?.hash);
    if (!hash || !lt || !Array.isArray(tx?.out_msgs)) return null;

    // Some APIs do not repeat the queried account field per transaction.
    const reportedAccount = tx?.account;
    if (reportedAccount != null && raw(reportedAccount) !== expectedAccount) {
        throw new RoomWalletEvidenceUnavailable("OUTGOING_SOURCE_ACCOUNT_MISMATCH");
    }

    const externalHash = normalizeTonTransactionHash(tx.in_msg?.hash) ?? null;
    const success = tx.success === true;
    const failed = tx.success === false || tx.aborted === true
        || tx.description?.aborted === true
        || tx.description?.compute_ph?.success === false
        || tx.description?.action?.success === false;

    const outputs = tx.out_msgs.map(message => ({
        recipient: raw(message.destination),
        valueNano: nano(message.value),
        hash: normalizeTonTransactionHash(message.hash),
        bodyHash: normalizeTonTransactionHash(message.body_hash)
    }));
    return { lt, hash, externalHash, success, failed, outputs };
}

const identity = (out) => [
    out.recipient, out.valueNano, out.hash
].join("|");

/**
 * REQUIRE known exact wallet transaction hash+lt (historical evidence), or
 * exact externally signed intent hash. Supplying only recipient and value
 * is prohibited; those are routinely identical in successive games.
 */
export function verifyOutgoingPaymentFromBothProviders({
    tonapiTransactions,
    toncenterTransactions,
    roomWallet,
    recipientWallet,
    valueNano,
    knownWalletTransactionHash = null,
    knownWalletTransactionLt = null,
    signedExternalMessageHash = null
} = {}) {
    const account = raw(roomWallet);
    const recipient = raw(recipientWallet);
    const amount = nano(valueNano);
    const knownHash = knownWalletTransactionHash == null
        ? null : normalizeTonTransactionHash(knownWalletTransactionHash);
    const knownLt = knownWalletTransactionLt == null
        ? null : validLt(knownWalletTransactionLt);
    const signedHash = signedExternalMessageHash == null
        ? null : normalizeTonTransactionHash(signedExternalMessageHash);

    if (!account || !recipient || !amount
        || !Array.isArray(tonapiTransactions) || !Array.isArray(toncenterTransactions)
        || (knownHash === null) !== (knownLt === null)
        || ((knownHash === null && signedHash === null)
            || (knownWalletTransactionHash != null && knownHash == null)
            || (knownWalletTransactionLt != null && knownLt == null)
            || (signedExternalMessageHash != null && signedHash == null))) {
        throw new RoomWalletEvidenceUnavailable("OUTGOING_PROOF_IDENTITY_REQUIRED");
    }

    const a = tonapiTransactions.map(tx => normalizeOutgoing(tx, account)).filter(Boolean);
    const b = toncenterTransactions.map(tx => normalizeOutgoing(tx, account)).filter(Boolean);
    const byLt = new Map();
    for (const tx of b) {
        if (byLt.has(tx.lt)) {
            throw new RoomWalletEvidenceUnavailable("OUTGOING_DUPLICATE_PROVIDER_LT");
        }
        byLt.set(tx.lt, tx);
    }

    const proofs = [];
    let stillIndexing = 0;
    for (const first of a) {
        if (knownLt !== null && first.lt !== knownLt) continue;
        if (knownHash !== null && first.hash !== knownHash) {
            throw new RoomWalletEvidenceUnavailable("OUTGOING_KNOWN_HASH_CONFLICT");
        }
        if (signedHash !== null && first.externalHash !== signedHash) continue;

        const second = byLt.get(first.lt);
        if (!second) {
            stillIndexing++;
            continue;
        }
        if (first.hash !== second.hash || first.failed || second.failed) {
            if (first.hash !== second.hash) {
                throw new RoomWalletEvidenceUnavailable("OUTGOING_PROVIDERS_DISAGREE");
            }
            continue;
        }
        if (!first.success) continue;
        if (signedHash !== null
            && (second.externalHash == null || second.externalHash !== signedHash)) {
            throw new RoomWalletEvidenceUnavailable("OUTGOING_SIGNED_INTENT_NOT_VERIFIED");
        }

        const matches = first.outputs.filter(x =>
            x.recipient === recipient && x.valueNano === amount);
        if (matches.length === 0) continue;

        const secondMatches = second.outputs.filter(x =>
            x.recipient === recipient && x.valueNano === amount);
        if (matches.length !== 1 || secondMatches.length !== 1
            || identity(matches[0]) !== identity(secondMatches[0])
            || matches[0].hash === null) {
            throw new RoomWalletEvidenceUnavailable("OUTGOING_MESSAGES_DISAGREE");
        }
        proofs.push(Object.freeze({
            account,
            recipient,
            valueNano: amount,
            roomWalletTxLt: first.lt,
            roomWalletTxHash: first.hash,
            outboundMessageHash: matches[0].hash,
            signedExternalMessageHash: first.externalHash
        }));
    }

    if (proofs.length > 1) {
        throw new RoomWalletEvidenceUnavailable("OUTGOING_DUPLICATE_EXECUTION");
    }
    return Object.freeze({
        confirmed: proofs.length === 1,
        receipt: proofs[0] ?? null,
        stillIndexing,
        // A missing outbound proof never means NOT SENT. An HTTP timeout or
        // lagged indexer must not authorize re-broadcast.
        state: proofs.length === 1 ? "CHAIN_CONFIRMED" : "CONFIRMATION_UNKNOWN",
        broadcastAuthorized: false
    });
}
