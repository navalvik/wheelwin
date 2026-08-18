/**
 * R17.9L.7 — DepositMonitor observation lifecycle states.
 * Domain only. No TON, no DepositSession mutation.
 */

export const DEPOSIT_OBSERVATION_STATUS = Object.freeze({
    OBSERVED: "OBSERVED",
    VALIDATED: "VALIDATED",
    REJECTED: "REJECTED"
});

export const DEPOSIT_OBSERVATION_REJECTION_REASONS = Object.freeze({
    UNKNOWN_WALLET: "unknown_wallet",
    INSUFFICIENT_AMOUNT: "insufficient_amount",
    DUPLICATE_TRANSACTION: "duplicate_transaction",
    DEPOSIT_ID_MISMATCH: "deposit_id_mismatch",
    DEPOSIT_ADDRESS_MISMATCH: "deposit_address_mismatch",
    WATCH_NOT_FOUND: "watch_not_found",
    SEAT_ALREADY_FUNDED: "seat_already_funded"
});
