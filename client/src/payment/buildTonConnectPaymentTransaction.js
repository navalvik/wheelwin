/**
 * R6.16B / R7.69A — Build a TonConnect sendTransaction request.
 * Destination is GameEscrow. Payload is STAKE (preferred) or legacy text comment.
 */

import { beginCell, toNano } from "@ton/core";

const DEFAULT_VALID_UNTIL_SECONDS = 600;
const GAME_ESCROW_STAKE_OPCODE = 0x5354414B;

/**
 * Standard TON text-comment body (op = 0) as base64 BOC for TonConnect payload.
 * Legacy path — BlockchainMonitor can still match deposit.comment.
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
 * R7.69A — GameEscrow STAKE body (op + playerIndex) as base64 BOC.
 */
export function buildGameEscrowStakePayload(playerIndex) {

    const index = Number(playerIndex);

    if (!Number.isInteger(index) || index < 0 || index > 255) {

        throw new Error("playerIndex must be an integer 0..255 for STAKE payload");

    }

    return beginCell()
        .storeUint(GAME_ESCROW_STAKE_OPCODE, 32)
        .storeUint(index, 8)
        .endCell()
        .toBoc()
        .toString("base64");

}

/**
 * Convert authoritative requiredGram (whole GRM / TON units) to nanotons string.
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
 * @param {string} params.contractAddress — GameEscrow destination
 * @param {number|string} params.requiredGram — exact stake
 * @param {string} [params.paymentReference] — legacy comment (v4 / fallback)
 * @param {number} [params.playerIndex] — seat index for STAKE body (game mode)
 * @param {number} [params.validUntilSeconds=600]
 * @param {number} [params.nowMs]
 */
export function buildTonConnectPaymentTransaction({
    contractAddress,
    requiredGram,
    paymentReference = null,
    playerIndex = null,
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

    const payload = playerIndex != null && playerIndex !== ""
        ? buildGameEscrowStakePayload(playerIndex)
        : buildTonCommentPayload(paymentReference);

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
