/**
 * Build a PLAIN native TON payment message for WheelWin's GRAM denomination.
 * No Jetton master/wallet, token payload, escrow or server signing is involved.
 * This creates data only; it never prompts a wallet or submits a transfer.
 */
import { assessGramPaymentRequest, tonAccountIdentityOrNull } from "./gramPaymentAuthorization.js";

function encodePlainComment(reference) {
    // Matches the server's PaymentReferenceCodec / Toncenter comment mapper:
    // 32-bit zero opcode followed by UTF-8 bytes "WW1:<reference>".
    const bytes = new TextEncoder().encode("WW1:" + reference);
    const data = new Uint8Array(4 + bytes.length);
    data.set(bytes, 4);
    if (data.length > 127) throw new Error("Native GRAM comment exceeds one-cell capacity");
    const boc = new Uint8Array(13 + data.length);
    boc.set([0xb5, 0xee, 0x9c, 0x72, 1, 1, 1, 1, 0, data.length + 2, 0, 0, data.length * 2]);
    boc.set(data, 13);
    let binary = "";
    for (const byte of boc) binary += String.fromCharCode(byte);
    return btoa(binary);
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
