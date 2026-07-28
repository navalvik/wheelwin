/**
 * T2.7 — PaymentSessionManager typed errors.
 */

export class PaymentSessionManagerError extends Error {

    constructor(message, code = "PAYMENT_SESSION_MANAGER_ERROR", details = null) {

        super(message);

        this.name = "PaymentSessionManagerError";

        this.code = code;

        this.details = details ?? null;

    }

}

export class PaymentSessionAlreadyExistsError extends PaymentSessionManagerError {

    constructor(roomId, gameId = null) {

        super(
            `Payment session already exists | roomId=${roomId}`,
            "PAYMENT_SESSION_ALREADY_EXISTS",
            { roomId, gameId }
        );

        this.name = "PaymentSessionAlreadyExistsError";

    }

}

export class PaymentSessionNotFoundError extends PaymentSessionManagerError {

    constructor(identifier) {

        super(
            `Payment session not found | id=${identifier}`,
            "PAYMENT_SESSION_NOT_FOUND",
            { identifier }
        );

        this.name = "PaymentSessionNotFoundError";

    }

}

export class PaymentValidationError extends PaymentSessionManagerError {

    constructor(message, details = null) {

        super(message, "PAYMENT_VALIDATION_ERROR", details);

        this.name = "PaymentValidationError";

    }

}

export class DuplicatePaymentError extends PaymentSessionManagerError {

    constructor(paymentSessionId, playerId, txHash = null) {

        super(
            `Duplicate payment | session=${paymentSessionId} | player=${playerId}`,
            "DUPLICATE_PAYMENT",
            { paymentSessionId, playerId, txHash }
        );

        this.name = "DuplicatePaymentError";

    }

}

export class UnexpectedPaymentError extends PaymentSessionManagerError {

    constructor(message, details = null) {

        super(message, "UNEXPECTED_PAYMENT", details);

        this.name = "UnexpectedPaymentError";

    }

}

export class PaymentTimeoutError extends PaymentSessionManagerError {

    constructor(paymentSessionId) {

        super(
            `Payment session timed out | paymentSessionId=${paymentSessionId}`,
            "PAYMENT_TIMEOUT",
            { paymentSessionId }
        );

        this.name = "PaymentTimeoutError";

    }

}

export class PaymentRecoveryError extends PaymentSessionManagerError {

    constructor(message, details = null) {

        super(message, "PAYMENT_RECOVERY_ERROR", details);

        this.name = "PaymentRecoveryError";

    }

}

export class InvalidPaymentStateTransitionError extends PaymentSessionManagerError {

    constructor(paymentSessionId, fromStatus, toStatus) {

        super(
            `Invalid payment session transition | id=${paymentSessionId} | `
                + `from=${fromStatus} | to=${toStatus}`,
            "INVALID_PAYMENT_STATE_TRANSITION",
            { paymentSessionId, fromStatus, toStatus }
        );

        this.name = "InvalidPaymentStateTransitionError";

    }

}
