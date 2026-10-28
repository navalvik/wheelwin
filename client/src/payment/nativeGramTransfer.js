/**
 * Build a PLAIN native TON payment message for WheelWin's GRAM denomination.
 * No Jetton master/wallet, token payload, escrow or server signing is involved.
 * This creates data only; it never prompts a wallet or submits a transfer.
 */
import { assessGramPaymentRequest, tonAccountIdentityOrNull } from "./gramPaymentAuthorization.js";
import { beginCell } from "@ton/core";

function encodePlainComment(reference) {
    // Matches the server's PaymentReferenceCodec / Toncenter comment mapper:
    // 32-bit zero opcode followed by UTF-8 bytes "WW1:<reference>".
    const comment = "WW1:" + reference;
    if (new TextEncoder().encode(comment).length > 123) {
        throw new Error("Native GRAM comment exceeds one-cell capacity");
    }
    // A valid TON cell BOC must contain the correct cell descriptors and CRC.
    // @ton/core produces canonical BOCs; never synthesize BOC headers manually.
    return beginCell().storeUint(0, 32).storeStringTail(comment)
        .endCell().toBoc().toString("base64");
}

/**
 * validUntil: authoritative absolute UNIX seconds, never extended here.
 * Caller must check connected wallet network is Testnet global ID -3.
 */
export function buildNativeGramPaymentTransaction(payment, connectedWalletAddress, validUntil) {
    const preflight = assessGramPaymentRequest(payment, connectedWalletAddress);
    if (!preflight.ready) throw new Error("Native GRAM payment request not authorized: " + preflight.reason);
    // Deadline belongs to the room server and must never be extended by
    // a client clock, reconnect, button retry, or the wallet SDK.
    const deadlineMs = payment?.expiresAt;
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0 ||
        !Number.isSafeInteger(validUntil) || validUntil <= 0 ||
        validUntil !== Math.floor(deadlineMs / 1000) ||
        deadlineMs <= Date.now())
        throw new Error("Native GRAM payment expiry must match the unexpired authoritative room deadline");
    const recipient = tonAccountIdentityOrNull(payment.destination);
    if (!recipient) throw new Error("Invalid room wallet");
    return Object.freeze({
        validUntil,
        messages: Object.freeze([
            Object.freeze({
                address: recipient,
                amount: preflight.amountAtomic,
                payload: encodePlainComment(payment.reference)
            })
        ])
    });
}
