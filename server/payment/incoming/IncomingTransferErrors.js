/**
 * Phase 2 — Read-only incoming TON transfer adapter: error hierarchy.
 *
 * Every error extends the Phase 1 `PaymentError` base so the adapter shares
 * the existing error contract (`name`, `code`, `details`, `toJSON`) without
 * modifying any Phase 1 file.
 *
 * Errors split into three groups:
 *   1. provider boundary errors (the injected read-only client is missing,
 *      replies unusably, fails, or exposes a forbidden write operation);
 *   2. transaction record errors (a normalized record is malformed,
 *      incomplete, contradictory or unsupported — fail closed);
 *   3. observation / match errors (contradictory replay, ambiguous match).
 */

import { PaymentError } from "../PaymentErrors.js";

/** Base class for every Phase 2 incoming-transfer adapter error. */
export class IncomingTransferError extends PaymentError {

    constructor(message, details) {

        super("INCOMING_TRANSFER_ERROR", message, details);

    }

}

/** The injected provider client does not satisfy the read-only contract. */
export class ProviderContractError extends IncomingTransferError {

    constructor(message, details) {

        super(message, details);

        this.code = "PROVIDER_CONTRACT_VIOLATION";

    }

}

/** The provider client replied with something that is not a usable payload. */
export class ProviderResponseError extends IncomingTransferError {

    constructor(message, details) {

        super(message, details);

        this.code = "PROVIDER_RESPONSE_MALFORMED";

    }

}

/** The provider client threw or rejected while being read. */
export class ProviderRequestError extends IncomingTransferError {

    constructor(message, details) {

        super(message, details);

        this.code = "PROVIDER_REQUEST_FAILED";

    }

}

/**
 * A forbidden (write) operation was requested or exposed. Observation is
 * read-only: nothing in Phase 2 can send, broadcast or sign.
 */
export class ProviderOperationBlockedError extends IncomingTransferError {

    constructor(message, details) {

        super(message, details);

        this.code = "PROVIDER_OPERATION_BLOCKED";

    }

}

/**
 * The provider transaction identity is missing or malformed. Without it no
 * deterministic, idempotency-safe identifier can be derived.
 */
export class TransactionIdentityError extends IncomingTransferError {

    constructor(message, details) {

        super(message, details);

        this.code = "TRANSACTION_IDENTITY_INVALID";

    }

}

/** Mandatory fields of a provider transaction record are missing. */
export class TransactionRecordIncompleteError extends IncomingTransferError {

    constructor(message, details) {

        super(message, details);

        this.code = "TRANSACTION_RECORD_INCOMPLETE";

    }

}

/** Base class for unusable amount / time / direction / network values. */
export class TransactionRecordRejectedError extends IncomingTransferError {

    constructor(message, details) {

        super(message, details);

        this.code = "TRANSACTION_RECORD_REJECTED";

    }

}

/**
 * A provider record carries fields it must never carry (secret material).
 * The record is rejected; nothing is retained.
 */
export class SecretBearingRecordError extends TransactionRecordRejectedError {

    constructor(field, details) {

        super(
            `provider transaction record carries a forbidden secret-bearing field: ${field}`,
            { field, ...details }
        );

        this.code = "TRANSACTION_RECORD_SECRET_FIELD";

    }

}

/**
 * The same provider transaction identity was observed twice with different
 * content (contradictory replay). Identical replays are idempotent.
 */
export class ObservationConflictError extends IncomingTransferError {

    constructor(transactionId, details) {

        super(
            `conflicting observation for transaction identity ${transactionId}`,
            { transactionId, ...details }
        );

        this.code = "TRANSACTION_OBSERVATION_CONFLICT";

    }

}

/**
 * One normalized transfer matched more than one payment intent. The match is
 * rejected instead of arbitrarily resolved.
 */
export class AmbiguousTransferMatchError extends IncomingTransferError {

    constructor(transactionId, candidateReferences, details) {

        super(
            `transaction ${transactionId} matches multiple payment intents: `
                + `${candidateReferences.join(", ")}`,
            { transactionId, candidateReferences, ...details }
        );

        this.code = "TRANSFER_MATCH_AMBIGUOUS";

    }

}
