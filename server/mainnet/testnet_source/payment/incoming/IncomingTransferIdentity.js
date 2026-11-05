/**
 * Phase 2 — Deterministic transaction identity and exact integer amounts.
 *
 * Two pure primitives shared by the whole adapter:
 *
 *   1. `deriveIncomingTransactionId` — a transaction identifier scoped to the
 *      network and the provider transaction/account identity. Amount,
 *      destination, sender and timestamps are NEVER part of the identity:
 *      they describe a payment, not a transaction.
 *
 *   2. `parseAtomicAmount` — exact integer parsing with zero floating-point
 *      conversion. Providers routinely return amounts as strings; digit
 *      strings are accepted, anything with a fraction, exponent or sign is
 *      rejected.
 */

import { createHash } from "node:crypto";

import {
    INCOMING_TRANSACTION_ID_PREFIX,
    SUPPORTED_INCOMING_TRANSFER_NETWORKS,
    TRANSFER_REJECTION_REASON
} from "./IncomingTransferConstants.js";

import {
    TransactionIdentityError,
    TransactionRecordRejectedError
} from "./IncomingTransferErrors.js";

/**
 * Normalize a network identifier: trim + lowercase. Network comparison in
 * this adapter is deterministic and never guesses aliases
 * ("-net" / "_net" suffixes are provider vocabulary and stay out of scope).
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeNetwork(value) {

    if (typeof value !== "string" || value.trim() === "") {

        throw new TransactionIdentityError(
            "network must be a non-empty string"
        );

    }

    return value.trim().toLowerCase();

}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSupportedNetwork(value) {

    return typeof value === "string"
        && SUPPORTED_INCOMING_TRANSFER_NETWORKS.includes(value.trim().toLowerCase());

}

/**
 * Deterministic provider transaction identity, scoped to the network and the
 * provider account/transaction pair.
 *
 * The canonical payload is a fixed-key JSON array, so no delimiter in any
 * field can shift the interpretation of another field. The digest is stable
 * across processes and machines (SHA-256).
 *
 * @param {{ network: string, providerId?: string, accountId: string, transactionId: string }} identity
 * @returns {string} `${INCOMING_TRANSACTION_ID_PREFIX}<64 hex chars>`
 */
export function deriveIncomingTransactionId({
    network,
    providerId = "provider",
    accountId,
    transactionId
}) {

    const normalizedNetwork = normalizeNetwork(network);

    if (typeof accountId !== "string" || accountId.trim() === "") {

        throw new TransactionIdentityError(
            "provider accountId must be a non-empty string",
            { accountId }
        );

    }

    if (typeof transactionId !== "string" || transactionId.trim() === "") {

        throw new TransactionIdentityError(
            "provider transactionId must be a non-empty string",
            { transactionId }
        );

    }

    const normalizedProviderId = typeof providerId === "string" && providerId.trim() !== ""
        ? providerId.trim()
        : "provider";

    const canonical = JSON.stringify([
        normalizedNetwork,
        normalizedProviderId,
        accountId.trim(),
        transactionId.trim()
    ]);

    const digest = createHash("sha256").update(canonical, "utf8").digest("hex");

    return `${INCOMING_TRANSACTION_ID_PREFIX}${digest}`;

}

/**
 * Exact integer atomic-unit amount. No floating-point conversion happens at
 * any point: digit strings are parsed through BigInt, numbers must already be
 * safe integers.
 *
 * @param {unknown} value
 * @returns {number} positive safe integer
 */
export function parseAtomicAmount(value) {

    if (typeof value === "number") {

        if (!Number.isSafeInteger(value) || value <= 0) {

            throw new TransactionRecordRejectedError(
                "amountAtomic must be a positive safe integer (atomic units)",
                { amountAtomic: value, reason: TRANSFER_REJECTION_REASON.AMOUNT_NOT_EXACT_INTEGER }
            );

        }

        return value;

    }

    if (typeof value === "string") {

        const trimmed = value.trim();

        if (!/^[0-9]+$/.test(trimmed)) {

            throw new TransactionRecordRejectedError(
                "amountAtomic string must contain decimal digits only"
                    + " (no sign, fraction, exponent or whitespace)",
                { amountAtomic: value, reason: TRANSFER_REJECTION_REASON.AMOUNT_NOT_EXACT_INTEGER }
            );

        }

        const parsed = Number(BigInt(trimmed));

        if (!Number.isSafeInteger(parsed) || parsed <= 0) {

            throw new TransactionRecordRejectedError(
                "amountAtomic is zero or exceeds the safe integer range",
                { amountAtomic: value, reason: TRANSFER_REJECTION_REASON.AMOUNT_NOT_EXACT_INTEGER }
            );

        }

        return parsed;

    }

    throw new TransactionRecordRejectedError(
        "amountAtomic must be an exact positive integer or a digit string",
        { amountAtomic: value, reason: TRANSFER_REJECTION_REASON.AMOUNT_NOT_EXACT_INTEGER }
    );

}

/**
 * Exact integer epoch-milliseconds transaction time. Providers that report
 * seconds must convert in their own client; guessing a unit here would
 * corrupt the record.
 *
 * @param {unknown} value
 * @returns {number}
 */
export function parseTransactionTime(value) {

    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {

        throw new TransactionRecordRejectedError(
            "transactionTime must be a positive integer epoch-milliseconds value",
            { transactionTime: value, reason: TRANSFER_REJECTION_REASON.TRANSACTION_TIME_INVALID }
        );

    }

    return value;

}
