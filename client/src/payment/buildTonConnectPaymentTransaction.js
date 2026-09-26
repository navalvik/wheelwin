/**
 * Build a TonConnect payment request.
 *
 * Active gameplay path: a plain TON transfer to the authoritative Room Wallet.
 * No gameplay smart-contract payload is generated here.
 */

import { beginCell, toNano } from "@ton/core";

const DEFAULT_VALID_UNTIL_SECONDS = 600;

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

export function buildTonConnectPaymentTransaction({
    contractAddress = null,
    paymentDestination = null,
    requiredGram,
    paymentReference = null,
    allowLegacyComment = false,
    directTransfer = true,
    validUntilSeconds = DEFAULT_VALID_UNTIL_SECONDS,
    nowMs = Date.now()
} = {}) {
    const destination = String(paymentDestination ?? contractAddress ?? "").trim();
    if (!destination) {
        throw new Error("payment destination is required for TonConnect transaction");
    }

    const amount = requiredGramToNanotonString(requiredGram);
    let payload;

    if (directTransfer === true) {
        payload = undefined;
    } else if (allowLegacyComment === true) {
        payload = buildTonCommentPayload(paymentReference);
    } else {
        throw new Error("direct transfer is required for the active Room Wallet payment path");
    }

    const ttl = Number(validUntilSeconds);
    if (!Number.isFinite(ttl) || ttl <= 0) {
        throw new Error("validUntilSeconds must be a positive number");
    }

    return {
        validUntil: Math.floor(Number(nowMs) / 1000) + ttl,
        messages: [{
            address: destination,
            amount,
            ...(payload === undefined ? {} : { payload })
        }]
    };
}
