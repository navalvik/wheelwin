/**
 * R6.16B / R7.69A / R7.70C10 — Build a TonConnect sendTransaction request.
 * Destination is GameEscrow. Payload is STAKE (required) or intentional legacy comment.
 */

import { beginCell, toNano } from "@ton/core";

const DEFAULT_VALID_UNTIL_SECONDS = 600;
export const GAME_ESCROW_STAKE_OPCODE = 0x5354414B;

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

function hasUsablePlayerIndex(playerIndex) {

    return playerIndex != null && playerIndex !== "";

}

/**
 * @param {object} params
 * @param {string} params.contractAddress — GameEscrow destination
 * @param {number|string} params.requiredGram — exact stake
 * @param {string} [params.paymentReference] — legacy comment (v4 / intentional)
 * @param {number} [params.playerIndex] — seat index for STAKE body (game mode)
 * @param {boolean} [params.allowLegacyComment=false] — opt into text-comment payload
 * @param {number} [params.validUntilSeconds=600]
 * @param {number} [params.nowMs]
 */
export function buildTonConnectPaymentTransaction({
    contractAddress,
    requiredGram,
    paymentReference = null,
    playerIndex = null,
    allowLegacyComment = false,
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

    let payload;

    if (hasUsablePlayerIndex(playerIndex)) {

        payload = buildGameEscrowStakePayload(playerIndex);

    } else if (allowLegacyComment === true) {

        // Intentional v4 / legacy comment path only — never the GameEscrow default.
        payload = buildTonCommentPayload(paymentReference);

    } else {

        // R7.70C10 — fail closed: GameEscrow must never send payref text comments.
        throw new Error(
            "playerIndex is required for GameEscrow STAKE payment"
        );

    }

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
