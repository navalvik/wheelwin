/**
 * Phase 1 — Payment intent data model with validated state transitions.
 *
 * R5 — a payment intent identifies, at minimum:
 *   room, player, network, assigned destination wallet, expected sender,
 *   exact integer amount in atomic units, unique payment reference,
 *   creation time, absolute expiration time.
 *
 * R6 — the unique payment reference is the identity of a payment. Amount,
 * destination wallet and approximate timestamps are never sufficient.
 *
 * The model is immutable-by-default: fields are frozen on construction and
 * state changes go through `transition()`, which enforces the transition table.
 */

import {
    PAYMENT_INTENT_STATE,
    PAYMENT_INTENT_STATES,
    canTransition,
    isObligationOpen
} from "./PaymentIntentStatus.js";

import {
    PAYMENT_INTENT_SCHEMA_VERSION
} from "./RoomPaymentConstants.js";

import {
    InvalidPaymentStateTransitionError,
    PaymentIntentExpiredError,
    PaymentValidationError
} from "./PaymentErrors.js";

/**
 * @param {unknown} value
 * @returns {asserts value is string}
 */
function assertNonEmptyString(value, field) {

    if (typeof value !== "string" || value.trim() === "") {

        throw new PaymentValidationError(
            `${field} must be a non-empty string`,
            { field, value }
        );

    }

}

/**
 * Exact integer atomic-unit amount. No floating-point arithmetic is accepted.
 *
 * @param {unknown} value
 * @returns {asserts value is number}
 */
export function assertAtomicAmount(value) {

    if (typeof value !== "number"
        || !Number.isSafeInteger(value)
        || value <= 0) {

        throw new PaymentValidationError(
            "amountAtomic must be a positive safe integer (atomic units)",
            { amountAtomic: value }
        );

    }

}

export class PaymentIntent {

    constructor({
        paymentReference,
        roomId,
        playerId,
        network,
        destinationWalletId,
        destinationWalletAddress,
        expectedSender,
        amountAtomic,
        asset,
        createdAt,
        expiresAt,
        roomDeadlineMs,
        state = PAYMENT_INTENT_STATE.PENDING,
        transactionId = null,
        updatedAt = null,
        schemaVersion = PAYMENT_INTENT_SCHEMA_VERSION
    }) {

        // --- R5: mandatory identity fields ---------------------------------
        assertNonEmptyString(paymentReference, "paymentReference");
        assertNonEmptyString(roomId, "roomId");
        assertNonEmptyString(playerId, "playerId");
        assertNonEmptyString(network, "network");
        assertNonEmptyString(destinationWalletId, "destinationWalletId");
        assertNonEmptyString(destinationWalletAddress, "destinationWalletAddress");
        assertNonEmptyString(expectedSender, "expectedSender");
        assertNonEmptyString(asset, "asset");

        assertAtomicAmount(amountAtomic);

        if (!Number.isInteger(createdAt) || createdAt <= 0) {

            throw new PaymentValidationError(
                "createdAt must be a positive integer epoch-milliseconds value",
                { createdAt }
            );

        }

        if (!Number.isInteger(expiresAt) || expiresAt <= createdAt) {

            throw new PaymentValidationError(
                "expiresAt must be a positive integer after createdAt",
                { createdAt, expiresAt }
            );

        }

        if (!Number.isInteger(roomDeadlineMs) || roomDeadlineMs <= createdAt) {

            throw new PaymentValidationError(
                "roomDeadlineMs must be a positive integer after createdAt",
                { createdAt, roomDeadlineMs }
            );

        }

        if (expiresAt > roomDeadlineMs) {

            throw new PaymentValidationError(
                "expiresAt must not exceed the immutable room deadline",
                { expiresAt, roomDeadlineMs }
            );

        }

        if (!PAYMENT_INTENT_STATES.includes(state)) {

            throw new PaymentValidationError(
                `unknown payment intent state: ${state}`,
                { state }
            );

        }

        if (transactionId !== null) {

            assertNonEmptyString(transactionId, "transactionId");

            if (state !== PAYMENT_INTENT_STATE.MATCHED
                && state !== PAYMENT_INTENT_STATE.SETTLED
                && state !== PAYMENT_INTENT_STATE.REFUNDED) {

                throw new PaymentValidationError(
                    "transactionId can only be present on matched/settled/"
                        + "refunded payment intents",
                    { state, transactionId }
                );

            }

        }

        this.paymentReference = paymentReference;

        this.roomId = roomId;

        this.playerId = playerId;

        this.network = network;

        this.destinationWalletId = destinationWalletId;

        this.destinationWalletAddress = destinationWalletAddress;

        this.expectedSender = expectedSender;

        this.amountAtomic = amountAtomic;

        this.asset = asset;

        this.createdAt = createdAt;

        this.expiresAt = expiresAt;

        this.roomDeadlineMs = roomDeadlineMs;

        this.state = state;

        this.transactionId = transactionId;

        this.updatedAt = Number.isInteger(updatedAt) ? updatedAt : null;

        this.schemaVersion = schemaVersion;

        Object.freeze(this);

    }

    /**
     * R7 — the single transaction identifier credited to this intent.
     */
    getCreditIdentifier() {

        return this.transactionId;

    }

    /**
     * @returns {boolean}
     */
    hasOpenObligation() {

        return isObligationOpen(this.state);

    }

    /**
     * @param {number} [now]
     * @returns {boolean}
     */
    isExpired(now = Date.now()) {

        return now >= this.expiresAt;

    }

    /**
     * Validated state transition. Returns a NEW frozen PaymentIntent; the
     * receiver is never mutated.
     *
     * @param {string} toState
     * @param {{ transactionId?: string, now?: number, force?: boolean }} [options]
     * @returns {PaymentIntent}
     */
    transition(toState, options = {}) {

        const now = options.now ?? Date.now();

        if (!canTransition(this.state, toState)) {

            throw new InvalidPaymentStateTransitionError(
                this.state,
                toState,
                { paymentReference: this.paymentReference }
            );

        }

        // An expired intent can only be moved to a valid terminal state, and it
        // must never be credited after its absolute expiration.
        if (this.isExpired(now) && toState !== PAYMENT_INTENT_STATE.EXPIRED) {

            throw new PaymentIntentExpiredError(
                this.paymentReference,
                this.expiresAt,
                { attemptedState: toState }
            );

        }

        const nextFields = {
            ...this.toRecord(),
            state: toState,
            updatedAt: now
        };

        if (Object.prototype.hasOwnProperty.call(options, "transactionId")) {

            nextFields.transactionId = options.transactionId ?? null;

        }

        return new PaymentIntent(nextFields);

    }

    /**
     * Serializable record (also the durable-storage payload).
     */
    toRecord() {

        return Object.freeze({
            schemaVersion: this.schemaVersion,
            paymentReference: this.paymentReference,
            roomId: this.roomId,
            playerId: this.playerId,
            network: this.network,
            destinationWalletId: this.destinationWalletId,
            destinationWalletAddress: this.destinationWalletAddress,
            expectedSender: this.expectedSender,
            amountAtomic: this.amountAtomic,
            asset: this.asset,
            createdAt: this.createdAt,
            expiresAt: this.expiresAt,
            roomDeadlineMs: this.roomDeadlineMs,
            state: this.state,
            transactionId: this.transactionId,
            updatedAt: this.updatedAt
        });

    }

    /**
     * Safe public snapshot. Never includes wallet secrets and never includes
     * anything that would identify the payment by amount + destination + time.
     */
    toSnapshot() {

        return Object.freeze({
            paymentReference: this.paymentReference,
            roomId: this.roomId,
            playerId: this.playerId,
            network: this.network,
            destinationWalletId: this.destinationWalletId,
            destinationWalletAddress: this.destinationWalletAddress,
            expectedSender: this.expectedSender,
            amountAtomic: this.amountAtomic,
            asset: this.asset,
            createdAt: this.createdAt,
            expiresAt: this.expiresAt,
            roomDeadlineMs: this.roomDeadlineMs,
            state: this.state,
            transactionId: this.transactionId,
            updatedAt: this.updatedAt,
            hasOpenObligation: this.hasOpenObligation()
        });

    }

    /**
     * Rebuild from a persisted record with full validation (fail closed).
     *
     * @param {object} record
     * @returns {PaymentIntent}
     */
    static fromRecord(record) {

        if (!record || typeof record !== "object") {

            throw new PaymentValidationError(
                "payment intent record must be a non-null object"
            );

        }

        return new PaymentIntent(record);

    }

}
