import { createHash } from "node:crypto";
import { mainnetAddressIdentity } from "./MainnetAddress.js";

const ASSET = "TON";
const REFERENCE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function resolveAddress(value, addressBook) {
    if (typeof value === "string") return value.trim();
    if (!value || typeof value !== "object") return "";
    const raw = typeof value.address === "string" ? value.address : "";
    const mapped = raw ? addressBook[raw] : null;
    return typeof mapped?.user_friendly === "string" ? mapped.user_friendly : raw;
}

function textComment(message) {
    const decoded = message?.message_content?.decoded;
    if (!message?.message_content) {
        return { hasComment: false, reference: null, malformed: false };
    }
    if (decoded?.type !== "text_comment" || typeof decoded.comment !== "string") {
        return { hasComment: true, reference: null, malformed: true };
    }
    const comment = decoded.comment;
    if (comment === "") return { hasComment: false, reference: null, malformed: false };
    if (!comment.startsWith("WW1:")) return { hasComment: true, reference: null, malformed: true };
    const reference = comment.slice(4);
    return REFERENCE_PATTERN.test(reference)
        ? { hasComment: true, reference, malformed: false }
        : { hasComment: true, reference: null, malformed: true };
}

function successful(transaction) {
    if (transaction.emulated === true || transaction.description?.aborted === true) return false;
    if (transaction.description?.compute_ph?.success === false) return false;
    if (transaction.description?.action?.success === false) return false;
    return true;
}

function transactionIdentity(accountIdentity, providerHash) {
    return createHash("sha256")
        .update(`mainnet\0toncenter\0${accountIdentity}\0${providerHash}`)
        .digest("hex");
}

export function mapMainnetTransactionsResponse(payload, { account, floorMs, ceilingMs, limit }) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)
        || !Array.isArray(payload.transactions)) {
        throw new Error("MAINNET_TONCENTER_TRANSACTIONS_ENVELOPE_INVALID");
    }
    const accountIdentity = mainnetAddressIdentity(account);
    const addressBook = payload.address_book && typeof payload.address_book === "object"
        ? payload.address_book : {};
    const records = [];
    for (const tx of payload.transactions) {
        if (!tx || typeof tx !== "object" || typeof tx.hash !== "string" || !tx.hash.trim()
            || !Number.isSafeInteger(tx.now) || tx.now <= 0) {
            throw new Error("MAINNET_TONCENTER_TRANSACTION_IDENTITY_INVALID");
        }
        const transactionTime = tx.now * 1000;
        if (!Number.isSafeInteger(transactionTime)) {
            throw new Error("MAINNET_TONCENTER_TRANSACTION_TIME_INVALID");
        }
        if (transactionTime < floorMs || transactionTime > ceilingMs || !successful(tx)) continue;
        const message = tx.in_msg;
        if (!message || typeof message !== "object") continue;
        const sourceAddress = resolveAddress(message.source, addressBook);
        const destinationAddress = resolveAddress(message.destination, addressBook);
        if (!sourceAddress || !destinationAddress) continue;
        let destinationIdentity;
        try {
            mainnetAddressIdentity(sourceAddress);
            destinationIdentity = mainnetAddressIdentity(message.destination?.address ?? message.destination);
        }
        catch { continue; }
        if (destinationIdentity !== accountIdentity) continue;
        if (typeof tx.account === "string" && tx.account.trim()) {
            try {
                if (mainnetAddressIdentity(tx.account) !== accountIdentity) continue;
            } catch { continue; }
        }
        if (typeof message.value !== "string" || !/^(0|[1-9][0-9]*)$/.test(message.value)) {
            throw new Error("MAINNET_TONCENTER_AMOUNT_INVALID");
        }
        if (BigInt(message.value) <= 0n) continue;
        const comment = textComment(message);
        records.push(Object.freeze({
            network: "mainnet",
            globalId: -239,
            providerId: "toncenter",
            providerTransactionId: tx.hash,
            transactionId: transactionIdentity(accountIdentity, tx.hash),
            accountId: account.trim(),
            sourceAddress,
            destinationAddress,
            amountAtomic: message.value,
            asset: ASSET,
            transactionTime,
            paymentReference: comment.reference,
            hasComment: comment.hasComment,
            malformedComment: comment.malformed,
            indexedTransaction: Object.freeze({
                transactionId: tx.hash,
                accountId: account.trim(),
                block: tx.block_ref ?? null,
                mcBlockSeqno: tx.mc_block_seqno ?? null,
                emulated: tx.emulated === true
            })
        }));
    }
    return Object.freeze({
        records: Object.freeze(records),
        rowsReturned: payload.transactions.length,
        resultWindowComplete: payload.transactions.length < limit
    });
}
