/**
 * Phase 4 — Server-authoritative internal ledger + payout accounting.
 *
 * Isolated error hierarchy for the internal ledger and payout calculator.
 * Every error extends the Phase 1 `PaymentError` base so `code`, `name`,
 * frozen `details` and `toJSON()` behave exactly like the rest of the payment
 * layer. Nothing here restores the removed historical financial subsystem, and
 * nothing here can send, broadcast or sign anything.
 */

import { PaymentError } from "../PaymentErrors.js";

/**
 * An immutable ledger entry was rejected (missing identity, non-integer or
 * non-positive atomic amount, unknown entry kind, ...).
 */
export class LedgerEntryError extends PaymentError {

    constructor(message, details) {

        super("LEDGER_ENTRY_INVALID", message, details);

    }

}

/**
 * A ledger entry was booked twice, or an idempotency key collided with a
 * different entry. A financial transaction can never be booked twice, and a
 * silent overwrite of an existing entry is impossible by design.
 */
export class LedgerReplayError extends PaymentError {

    constructor(idempotencyKey, details) {

        super(
            "LEDGER_ENTRY_DUPLICATE",
            `ledger idempotency key already booked: ${idempotencyKey}`,
            { idempotencyKey, ...details }
        );

    }

}

/** A persisted ledger record failed integrity validation (fail closed). */
export class CorruptedLedgerRecordError extends PaymentError {

    constructor(entryId, reason, details) {

        super(
            "LEDGER_RECORD_CORRUPTED",
            `persisted ledger entry is corrupted: ${entryId} | ${reason}`,
            { entryId, reason, ...details }
        );

    }

}

/** Durable ledger storage read/write failure. */
export class LedgerStorageError extends PaymentError {

    constructor(message, details) {

        super("LEDGER_STORAGE_ERROR", message, details);

    }

}

/**
 * A required payout allocation rule is missing or contradictory. `missing`
 * lists the exact configuration fields that must be supplied; the payout plan
 * is rejected rather than inventing a value.
 */
export class PayoutAllocationConfigError extends PaymentError {

    constructor(message, details) {

        super("PAYOUT_ALLOCATION_INVALID", message, details);

    }

}

/**
 * A network-fee quote was missing, not a positive integer, stale (older than
 * the allowed quote age) or greater than / equal to the recipient's gross
 * allocation. Each outgoing payout represents its own network fee separately.
 */
export class PayoutFeeError extends PaymentError {

    constructor(code, message, details) {

        super(`PAYOUT_FEE_${code}`, message, details);

    }

}

/**
 * A payout could not be settled: no execution result was supplied, or the
 * actual network fee differs from the reserved fee and an explicit idempotent
 * reconciliation has not been recorded yet.
 */
export class PayoutSettlementError extends PaymentError {

    constructor(message, details) {

        super("PAYOUT_SETTLEMENT_BLOCKED", message, details);

    }

}

/** Generic payout validation failure (bad inputs, negative nets, ...). */
export class PayoutValidationError extends PaymentError {

    constructor(message, details) {

        super("PAYOUT_VALIDATION_INVALID", message, details);

    }

}
