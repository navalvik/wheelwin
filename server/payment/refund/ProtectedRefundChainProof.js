/**
 * Advisory, read-only receipt assessment of an already-held refund intention.
 * The two indexed chain histories must agree on exact source-wallet tx LT/hash,
 * signed external message hash, beneficiary, value and output message identity.
 * Without an independently verified advanced wallet seqno AND trusted finality
 * this is not permission to mark debt COMPLETE or release the wallet lock.
 *
 * This function has no fetch, persistence, signer or broadcaster capability.
 * Callers must not treat caller-supplied provider arrays as authoritative.
 */
import { verifyOutgoingPaymentFromBothProviders } from "../roomWallet/RoomWalletDualSourceOutgoingReceipt.js";

export class ProtectedRefundReceiptError extends Error {
    constructor(code) { super(code); this.name = "ProtectedRefundReceiptError"; this.code = code; }
}
export function assessProtectedRefundReceipt({
    journal, intentId, tonapiTransactions, toncenterTransactions
} = {}) {
    if (typeof journal?.load !== "function"
        || typeof intentId !== "string") {
        throw new ProtectedRefundReceiptError("REFUND_RECEIPT_INPUT_INVALID");
    }
    const held = journal.load(intentId);
    if (!["SIGNED_HELD", "CONFIRMATION_UNKNOWN"].includes(held.state)
        || !/^[0-9a-f]{64}$/i.test(String(held.signedHash))
        || !Number.isSafeInteger(held.seqno) || held.seqno < 0) {
        throw new ProtectedRefundReceiptError("REFUND_RECEIPT_NOT_SIGNED_HELD");
    }
    const match = verifyOutgoingPaymentFromBothProviders({
        roomWallet: held.fromWallet,
        recipientWallet: held.toWallet,
        valueNano: String(held.netAtomic),
        signedExternalMessageHash: held.signedHash,
        tonapiTransactions, toncenterTransactions
    });
    return Object.freeze({
        intentId,
        status: match.confirmed
            ? "RECEIPT_OBSERVED_PENDING_SEQNO_FINALITY"
            : "CONFIRMATION_UNKNOWN",
        receipt: match.receipt,
        missingSecondProvider: match.stillIndexing > 0,
        broadcastAuthorized: false,
        refundCompleteAuthorized: false,
        walletReleaseAuthorized: false
    });
}
