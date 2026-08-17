/**
 * R17.9L.3 — DepositSession typed errors.
 */

export class DepositSessionError extends Error {

    constructor(message, code = "DEPOSIT_SESSION_ERROR", details = null) {

        super(message);

        this.name = "DepositSessionError";

        this.code = code;

        this.details = details ?? null;

    }

}

export class InvalidDepositIdentityError extends DepositSessionError {

    constructor(reason, details = null) {

        super(reason, "INVALID_DEPOSIT_IDENTITY", details);

        this.name = "InvalidDepositIdentityError";

    }

}

export class InvalidDepositBindingError extends DepositSessionError {

    constructor(reason, details = null) {

        super(reason, "INVALID_DEPOSIT_BINDING", details);

        this.name = "InvalidDepositBindingError";

    }

}

export class InvalidDepositFundingError extends DepositSessionError {

    constructor(reason, details = null) {

        super(reason, "INVALID_DEPOSIT_FUNDING", details);

        this.name = "InvalidDepositFundingError";

    }

}

export class InvalidDepositStateTransitionError extends DepositSessionError {

    constructor(depositId, fromStatus, toStatus) {

        super(
            `Invalid deposit session transition | id=${depositId} | `
                + `from=${fromStatus} | to=${toStatus}`,
            "INVALID_DEPOSIT_STATE_TRANSITION",
            { depositId, fromStatus, toStatus }
        );

        this.name = "InvalidDepositStateTransitionError";

    }

}
