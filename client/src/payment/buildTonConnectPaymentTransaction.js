/**
 * R6.16B / R7.69A / R7.70C10 — Build a TonConnect sendTransaction request.
 * Destination is GameEscrow. Payload is STAKE (required) or intentional legacy comment.
 */

import { toNano } from "@ton/core";

const DEFAULT_VALID_UNTIL_SECONDS = 600;
export const GAME_ESCROW_STAKE_OPCODE = 0x5354414B;

/**
 * Standard TON text-comment body (op = 0) as base64 BOC for TonConnect payload.
 * Legacy path — BlockchainMonitor can still match deposit.comment.
 */
export function buildTonCommentPayload() {

    throw new Error("Smart-contract payment payloads are disabled");

}

export function buildGameEscrowStakePayload() {

    throw new Error("GameEscrow STAKE payloads are disabled");

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

export function buildTonConnectPaymentTransaction({
    contractAddress,
    requiredGram,
    plainTransfer = false,
    validUntilSeconds = DEFAULT_VALID_UNTIL_SECONDS,
    nowMs = Date.now()
} = {}) {

    if (plainTransfer !== true) {

        throw new Error("Smart-contract player payment is disabled; use a plain Room Wallet transfer");

    }

    if (typeof contractAddress !== "string" || contractAddress.trim() === "") {

        throw new Error("contractAddress is required for TonConnect transaction");

    }

    const amount = requiredGramToNanotonString(requiredGram);
    const ttl = Number(validUntilSeconds);

    if (!Number.isFinite(ttl) || ttl <= 0) {

        throw new Error("validUntilSeconds must be a positive number");

    }

    return {
        validUntil: Math.floor(Number(nowMs) / 1000) + ttl,
        messages: [{
            address: contractAddress.trim(),
            amount
        }]
    };

}
