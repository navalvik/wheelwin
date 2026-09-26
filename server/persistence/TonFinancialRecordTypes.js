/**
 * T2.1 — TonFinancialPersistence record type identifiers.
 */

export const TON_FINANCIAL_RECORD_TYPES = Object.freeze({
    PAYMENT_SESSION: "payment_session",
    WALLET_SESSION: "wallet_session",
    SETTLEMENT: "settlement",
    SNAPSHOT: "snapshot",
    RECOVERY_CHECKPOINT: "recovery_checkpoint",
    AUDIT: "audit",
    // R17.9L.4 / L.5A — Deposit Security Layer records.
    DEPOSIT_SESSION: "deposit_session",
    DEPLOYMENT_AUTHORIZATION: "deployment_authorization",
    // R17.9L.7 — immutable on-chain funding observation facts.
    DEPOSIT_OBSERVATION: "deposit_observation",
    // R17.9T.6-C — Recovery Data Contract persistence (gameplay recovery data).
    RECOVERY_DATA: "recovery_data"
});

export const TON_FINANCIAL_SCHEMA_VERSION = 1;

/**
 * Record types that are immutable immediately on create.
 */
export const IMMUTABLE_ON_CREATE_TYPES = Object.freeze([
    TON_FINANCIAL_RECORD_TYPES.SNAPSHOT,
    TON_FINANCIAL_RECORD_TYPES.AUDIT,
    TON_FINANCIAL_RECORD_TYPES.DEPOSIT_OBSERVATION
]);

/**
 * Record types that may be deleted (temporary objects only).
 */
export const DELETABLE_RECORD_TYPES = Object.freeze([
    TON_FINANCIAL_RECORD_TYPES.RECOVERY_CHECKPOINT
]);

/**
 * Settlement statuses after which the record becomes immutable.
 */
export const SETTLEMENT_TERMINAL_STATUSES = Object.freeze([
    "SETTLEMENT_COMPLETED",
    "SETTLEMENT_FAILED"
]);

/** R17.9L.4 — terminal deposit_session statuses (immutable envelopes). */
export const DEPOSIT_SESSION_TERMINAL_STATUSES = Object.freeze([
    "RELEASED",
    "REIMBURSED",
    "REFUNDED"
]);

/** R17.9L.5A — terminal deployment_authorization statuses (immutable envelopes). */
export const DEPLOYMENT_AUTHORIZATION_TERMINAL_STATUSES = Object.freeze([
    "CONSUMED",
    "REVOKED"
]);

/**
 * R17.9T.6-C — Recovery Data Contract terminal statuses.
 *
 * Terminal recovery records are immutable after creation. These statuses
 * represent games that have reached a terminal state (RESULT phase with
 * physics STOPPED, or settlement completed/failed) where the recovery
 * record must never be modified again.
 *
 * Pre-game / active recovery records use status "ACTIVE" and remain mutable
 * until the game reaches a terminal state.
 */
export const RECOVERY_DATA_TERMINAL_STATUSES = Object.freeze([
    "TERMINAL",
    "SETTLED",
    "FAILED_CLOSED"
]);

export const RECORD_STORAGE_CATEGORY = Object.freeze({
    [TON_FINANCIAL_RECORD_TYPES.PAYMENT_SESSION]: "active",
    [TON_FINANCIAL_RECORD_TYPES.WALLET_SESSION]: "active",
    [TON_FINANCIAL_RECORD_TYPES.SETTLEMENT]: "active",
    [TON_FINANCIAL_RECORD_TYPES.RECOVERY_CHECKPOINT]: "active",
    [TON_FINANCIAL_RECORD_TYPES.DEPOSIT_SESSION]: "active",
    [TON_FINANCIAL_RECORD_TYPES.DEPLOYMENT_AUTHORIZATION]: "active",
    [TON_FINANCIAL_RECORD_TYPES.DEPOSIT_OBSERVATION]: "immutable",
    [TON_FINANCIAL_RECORD_TYPES.SNAPSHOT]: "immutable",
    [TON_FINANCIAL_RECORD_TYPES.AUDIT]: "immutable",
    [TON_FINANCIAL_RECORD_TYPES.RECOVERY_DATA]: "active"
});
