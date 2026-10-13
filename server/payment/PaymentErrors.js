/**
 * Phase 1 — Room Wallet Payment Core.
 *
 * Self-contained error hierarchy for the new Room Wallet Payment Layer.
 * Deliberately isolated from the pre-existing (removed) financial subsystem:
 * no dependency on any historical contract/payment code.
 */

export class PaymentError extends Error {

    constructor(code, message, details = {}) {

        super(message);

        this.name = new.target.name;

        this.code = code;

        this.details = Object.freeze({ ...details });

    }

    toJSON() {

        return Object.freeze({
            name: this.name,
            code: this.code,
            message: this.message,
            details: this.details
        });

    }

}

/**
 * Invalid configuration supplied to the payment core (asset / denomination
 * mapping missing, malformed wallet pool, unreadable storage directory).
 */
export class PaymentConfigurationError extends PaymentError {

    constructor(message, details) {

        super("PAYMENT_CONFIGURATION_INVALID", message, details);

    }

}

/**
 * A payment reference was reused. Every player payment must be represented by
 * a distinct, persistent payment intent keyed by its unique reference.
 */
export class PaymentReferenceCollisionError extends PaymentError {

    constructor(paymentReference, details) {

        super(
            "PAYMENT_REFERENCE_DUPLICATE",
            `payment reference already exists: ${paymentReference}`,
            { paymentReference, ...details }
        );

    }

}

/** An expired payment intent was mutated or credited. */
export class PaymentIntentExpiredError extends PaymentError {

    constructor(paymentReference, expiresAt, details) {

        super(
            "PAYMENT_INTENT_EXPIRED",
            `payment intent already expired: ${paymentReference}`,
            { paymentReference, expiresAt, ...details }
        );

    }

}

/** A state transition that the payment intent lifecycle does not permit. */
export class InvalidPaymentStateTransitionError extends PaymentError {

    constructor(fromState, toState, details) {

        super(
            "PAYMENT_STATE_TRANSITION_INVALID",
            `invalid payment intent transition: ${fromState} -> ${toState}`,
            { fromState, toState, ...details }
        );

    }

}

/**
 * A duplicate wallet assignment or a conflicting active reservation was
 * requested (at most one wallet per active room; one owner per wallet).
 */
export class WalletAssignmentConflictError extends PaymentError {

    constructor(message, details) {

        super("WALLET_ASSIGNMENT_CONFLICT", message, details);

    }

}

/** The wallet pool has no wallet available for the requested reservation. */
export class WalletPoolExhaustedError extends PaymentError {

    constructor(network, details) {

        super(
            "WALLET_POOL_EXHAUSTED",
            `no unreserved room wallet available for network ${network}`,
            { network, ...details }
        );

    }

}

/**
 * A wallet could not be recycled because its previous still has unresolved
 * payment or refund obligations.
 */
export class WalletRecyclingBlockedError extends PaymentError {

    constructor(walletId, roomId, unresolvedObligations, details) {

        super(
            "WALLET_RECYCLING_BLOCKED",
            `wallet ${walletId} is blocked by ${unresolvedObligations} unresolved `
                + `obligation(s) from room ${roomId}`,
            { walletId, roomId, unresolvedObligations, ...details }
        );

    }

}

/**
 * A blockchain transaction identifier was already credited to another
 * payment intent. One transaction can settle at most one intent.
 */
export class TransactionAlreadyCreditedError extends PaymentError {

    constructor(transactionId, paymentReference, details) {

        super(
            "TRANSACTION_ALREADY_CREDITED",
            `transaction ${transactionId} is already credited to `
                + `${paymentReference}`,
            { transactionId, creditedTo: paymentReference, ...details }
        );

    }

}

/**
 * Payment execution is not permitted in this phase, or the asset /
 * denomination mapping required to compute atomic amounts is not configured.
 */
export class PaymentExecutionBlockedError extends PaymentError {

    constructor(message, details) {

        super("PAYMENT_EXECUTION_BLOCKED", message, details);

    }

}

/** Durable storage read/write failure. */
export class PaymentStorageError extends PaymentError {

    constructor(message, details) {

        super("PAYMENT_STORAGE_ERROR", message, details);

    }

}

/** A persisted record failed integrity validation (fail closed). */
export class CorruptedPaymentRecordError extends PaymentError {

    constructor(paymentReference, reason, details) {

        super(
            "PAYMENT_RECORD_CORRUPTED",
            `persisted payment intent is corrupted: ${paymentReference} | `
                + `${reason}`,
            { paymentReference, reason, ...details }
        );

    }

}

/** Requested payment intent does not exist in the store. */
export class PaymentIntentNotFoundError extends PaymentError {

    constructor(paymentReference, details) {

        super(
            "PAYMENT_INTENT_NOT_FOUND",
            `payment intent not found: ${paymentReference}`,
            { paymentReference, ...details }
        );

    }

}

/** Generic argument validation failure for the payment core. */
export class PaymentValidationError extends PaymentError {

    constructor(message, details) {

        super("PAYMENT_VALIDATION_INVALID", message, details);

    }

}
