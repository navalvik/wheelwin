/**
 * R6.16B — Build a TonConnect sendTransaction request from authoritative
 * payment-session seat fields. Does not verify payment or touch chain state.
 */

import { beginCell, toNano } from "@ton/core";

const DEFAULT_VALID_UNTIL_SECONDS = 600;

/**
 * Standard TON text-comment body (op = 0) as base64 BOC for TonConnect payload.
 * BlockchainMonitor matches deposit.comment against paymentReference.
 */
export function buildTonCommentPayload(comment) {

    if (comment == null || String(comment).trim() === "") {

        throw new Error("paymentReference is required for TonConnect payload");

    }

    return beginCell()
        .storeUint(0, 32)
        .storeStringTail(String(comment))
        .endCell()
        .toBoc()
        .toString("base64");

}

/**
 * Convert authoritative requiredGram (whole GRM / TON units) to nanotons string.
 * Matches BlockchainMonitor parseDepositCandidate (nanotons / 1e9 → amountGram).
 */
export function requiredGramToNanotonString(requiredGram) {

    if (requiredGram == null || requiredGram === "") {

        throw new Error("requiredGram is required for TonConnect amount");

    }

    const asNumber = Number(requiredGram);

    if (!Number.isFinite(asNumber) || asNumber <= 0) {

        throw new Error("requiredGram must be a positive finite number");

    }

    return toNano(String(requiredGram)).toString();

}

/**
 * @param {object} params
 * @param {string} params.contractAddress — escrow destination
 * @param {number|string} params.requiredGram — whole GRM units from seat
 * @param {string} params.paymentReference — comment matched by BlockchainMonitor
 * @param {number} [params.validUntilSeconds=600]
 * @param {number} [params.nowMs]
 * @returns {{ validUntil: number, messages: Array<{ address: string, amount: string, payload: string }> }}
 */
export function buildTonConnectPaymentTransaction({
    contractAddress,
    requiredGram,
    paymentReference,
    validUntilSeconds = DEFAULT_VALID_UNTIL_SECONDS,
    nowMs = Date.now()
} = {}) {

    if (
        typeof contractAddress !== "string"
        || contractAddress.trim() === ""
    ) {

        throw new Error("contractAddress is required for TonConnect transaction");

    }

    const amount = requiredGramToNanotonString(requiredGram);

    const payload = buildTonCommentPayload(paymentReference);

    const ttl = Number(validUntilSeconds);

    if (!Number.isFinite(ttl) || ttl <= 0) {

        throw new Error("validUntilSeconds must be a positive number");

    }

    return {
        validUntil: Math.floor(Number(nowMs) / 1000) + ttl,
        messages: [
            {
                address: contractAddress.trim(),
                amount,
                payload
            }
        ]
    };

}
