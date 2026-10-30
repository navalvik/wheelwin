/**
 * Phase 2 — Pure match evaluation between a normalized incoming transfer and
 * a Phase 1 payment intent.
 *
 * This module NEVER mutates anything. It answers one question: could this
 * observed transaction be the payment for this intent? A positive answer is
 * strictly an evaluation result — it is not a confirmation, not a credit, and
 * not a state change. Only the Phase 1 service may transition an intent, and
 * only when explicitly asked to do so later.
 *
 * Address comparison is by CANONICAL ACCOUNT IDENTITY (Phase 3B): every
 * address on both sides is parsed and validated through
 * `TonAddressIdentity` into `<workchain>:<hash>` before comparison, so a raw
 * provider address and a user-friendly wallet-catalog address of the same
 * account match, while different workchains or account hashes never do. A
 * malformed address on either side can never match — it is reported as an
 * explicit invalid-address reason and never repaired, lowercased or
 * approximated into a match. Nothing about the original provider strings is
 * rewritten; identity is used for equality only.
 *
 * Matching rules (all must agree; the first failing rule is reported, all
 * failing rules are collected):
 *
 *   1. intent state — terminal states and intents already matched to a
 *      different transaction can never match;
 *   2. network — exact equality after normalization (no network guessing);
 *   3. destination wallet address — equality by validated canonical account
 *      identity (raw ↔ friendly forms of the same account match);
 *   4. destination wallet id — compared only when both sides supply one;
 *   5. sender — must equal the intent's expected sender, again by validated
 *      canonical account identity;
 *   6. asset — exact equality;
 *   7. amount — exact integer equality (no partial, over or under payment
 *      is ever a match);
 *   8. payment reference — an explicitly present reference must match.
 *      An absent reference may match only if the transfer identifies a
 *      unique payer intent by the remaining authoritative fields. The
 *      observer and settlement service enforce uniqueness independently.
 */

import { PaymentValidationError } from "../PaymentErrors.js";

import { IncomingTransfer } from "./IncomingTransfer.js";

import {
    PAYMENT_INTENT_STATE,
    isTerminalPaymentIntentState
} from "../PaymentIntentStatus.js";

import { normalizeNetwork } from "./IncomingTransferIdentity.js";

import { tonAddressIdentityOrNull } from "./TonAddressIdentity.js";

import {
    TRANSFER_MATCH_REASON
} from "./IncomingTransferConstants.js";

import {
    AmbiguousTransferMatchError
} from "./IncomingTransferErrors.js";

/**
 * Canonical account identity of one address, or `null` when it is not a
 * valid TON address. A `null` identity never matches anything: the caller
 * fails the match closed with an explicit invalid-address reason.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function addressIdentity(value) {

    return tonAddressIdentityOrNull(value);

}

/**
 * Compare one normalized incoming transfer against one payment intent.
 *
 * @param {IncomingTransfer} transfer
 * @param {object} intent a Phase 1 `PaymentIntent` (or an equivalent record)
 * @returns {Readonly<{
 *   matched: boolean,
 *   transactionId: string,
 *   paymentReference: string|null,
 *   reason: string|null,
 *   mismatches: readonly string[]
 * }>}
 */
export function matchIncomingTransferToIntent(transfer, intent) {

    if (!(transfer instanceof IncomingTransfer)) {

        throw new PaymentValidationError(
            "transfer must be an IncomingTransfer instance"
        );

    }

    if (!intent || typeof intent !== "object") {

        throw new PaymentValidationError(
            "intent must be a payment intent object"
        );

    }

    const mismatches = [];

    // --- 1. intent state ----------------------------------------------------
    const state = intent.state;

    if (isTerminalPaymentIntentState(state)) {

        mismatches.push(TRANSFER_MATCH_REASON.INTENT_NOT_MATCHABLE);

    } else if (state === PAYMENT_INTENT_STATE.MATCHED
        && intent.transactionId !== null
        && intent.transactionId !== transfer.transactionId) {

        // R7 — an intent already credited to a different transaction can
        // never accept this one.
        mismatches.push(TRANSFER_MATCH_REASON.INTENT_ALREADY_MATCHED);

    }

    // --- 2. network ----------------------------------------------------------
    if (transfer.network !== normalizeNetwork(intent.network)) {

        mismatches.push(TRANSFER_MATCH_REASON.NETWORK_MISMATCH);

    }

    // --- 3. destination wallet address --------------------------------------
    // Equality by validated canonical account identity: a raw provider
    // destination (`0:…`) and the intent's user-friendly wallet address
    // (`EQ…`/`UQ…`) of the same account agree. An address that cannot be
    // validated is invalid — never an approximate match.
    const transferDestinationIdentity = addressIdentity(
        transfer.destinationWalletAddress
    );

    const intentDestinationIdentity = addressIdentity(
        intent.destinationWalletAddress
    );

    if (transferDestinationIdentity === null
        || intentDestinationIdentity === null) {

        mismatches.push(TRANSFER_MATCH_REASON.DESTINATION_ADDRESS_INVALID);

    } else if (transferDestinationIdentity !== intentDestinationIdentity) {

        mismatches.push(TRANSFER_MATCH_REASON.DESTINATION_ADDRESS_MISMATCH);

    }

    // --- 4. destination wallet id (only when both sides supply one) ----------
    if (transfer.destinationWalletId !== null
        && typeof intent.destinationWalletId === "string"
        && intent.destinationWalletId.trim() !== ""
        && transfer.destinationWalletId !== intent.destinationWalletId.trim()) {

        mismatches.push(TRANSFER_MATCH_REASON.DESTINATION_WALLET_ID_MISMATCH);

    }

    // --- 5. sender ------------------------------------------------------------
    // Same validated canonical identity rule as the destination: the provider
    // raw sender form and the intent's expected sender representation must
    // denote the same TON account. Malformed on either side never matches.
    const transferSenderIdentity = addressIdentity(transfer.senderAddress);

    const intentSenderIdentity = addressIdentity(intent.expectedSender);

    if (transferSenderIdentity === null
        || intentSenderIdentity === null) {

        mismatches.push(TRANSFER_MATCH_REASON.SENDER_ADDRESS_INVALID);

    } else if (transferSenderIdentity !== intentSenderIdentity) {

        mismatches.push(TRANSFER_MATCH_REASON.SENDER_MISMATCH);

    }

    // --- 6. asset ---------------------------------------------------------------
    if (transfer.asset !== intent.asset) {

        mismatches.push(TRANSFER_MATCH_REASON.ASSET_MISMATCH);

    }

    // --- 7. amount -----------------------------------------------------------------
    if (transfer.amountAtomic !== intent.amountAtomic) {

        mismatches.push(TRANSFER_MATCH_REASON.AMOUNT_MISMATCH);

    }

    // --- 8. payment reference ----------------------------------------------------------
    const intentReference = typeof intent.paymentReference === "string"
        && intent.paymentReference.trim() !== ""
        ? intent.paymentReference.trim()
        : null;

    if (intentReference !== null) {

        if (transfer.paymentReference === null) {

            // The historical Room Wallet no-memo attribution is deliberately
            // Testnet native TON only. Do not relax other networks or assets.
            if (transfer.network !== "testnet" || intent.network !== "testnet"
                || transfer.asset !== "TON" || intent.asset !== "TON") {
                mismatches.push(TRANSFER_MATCH_REASON.PAYMENT_REFERENCE_MISSING);
            }

        } else if (transfer.paymentReference !== intentReference) {

            mismatches.push(TRANSFER_MATCH_REASON.PAYMENT_REFERENCE_MISMATCH);

        }

    }

    const matched = mismatches.length === 0;

    return Object.freeze({
        matched,
        transactionId: transfer.transactionId,
        paymentReference: intentReference,
        reason: matched ? null : mismatches[0],
        mismatches: Object.freeze([...mismatches])
    });

}

/**
 * Resolve one normalized incoming transfer against a set of payment intents.
 *
 * Exactly one intent may match. Zero matches is a normal (non-error) result;
 * more than one is an ambiguity and is rejected — never resolved arbitrarily.
 *
 * @param {IncomingTransfer} transfer
 * @param {Array<object>} intents
 * @returns {Readonly<object>}
 */
export function resolveIncomingTransferMatch(transfer, intents) {

    if (!(transfer instanceof IncomingTransfer)) {

        throw new PaymentValidationError(
            "transfer must be an IncomingTransfer instance"
        );

    }

    if (!Array.isArray(intents)) {

        throw new PaymentValidationError(
            "intents must be an array of payment intents"
        );

    }

    const matches = [];

    for (const intent of intents) {

        const result = matchIncomingTransferToIntent(transfer, intent);

        if (result.matched) {

            matches.push(result);

        }

    }

    if (matches.length > 1) {

        throw new AmbiguousTransferMatchError(
            transfer.transactionId,
            matches.map((match) => match.paymentReference),
            {
                network: transfer.network,
                amountAtomic: transfer.amountAtomic,
                paymentReference: transfer.paymentReference
            }
        );

    }

    if (matches.length === 1) {

        return matches[0];

    }

    return Object.freeze({
        matched: false,
        transactionId: transfer.transactionId,
        paymentReference: null,
        reason: TRANSFER_MATCH_REASON.NO_INTENT_MATCH,
        mismatches: Object.freeze([TRANSFER_MATCH_REASON.NO_INTENT_MATCH])
    });

}

/**
 * Resolve a list of transfers against a list of intents. Ambiguity on any
 * transfer throws, because an ambiguous observation must never be credited.
 *
 * @param {IncomingTransfer[]} transfers
 * @param {Array<object>} intents
 * @returns {ReadonlyArray<object>}
 */
export function resolveIncomingTransferMatches(transfers, intents) {

    if (!Array.isArray(transfers)) {

        throw new PaymentValidationError(
            "transfers must be an array of IncomingTransfer instances"
        );

    }

    return Object.freeze(
        transfers.map((transfer) => resolveIncomingTransferMatch(transfer, intents))
    );

}
