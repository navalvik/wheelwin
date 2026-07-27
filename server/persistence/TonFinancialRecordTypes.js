/**
 * T2.1 — TonFinancialPersistence record type identifiers.
 */

export const TON_FINANCIAL_RECORD_TYPES = Object.freeze({
    GAME_CONTRACT: "game_contract",
    PAYMENT_SESSION: "payment_session",
    WALLET_SESSION: "wallet_session",
    SETTLEMENT: "settlement",
    SNAPSHOT: "snapshot",
    RECOVERY_CHECKPOINT: "recovery_checkpoint",
    ARCHIVED_CONTRACT: "archived_contract",
    AUDIT: "audit"
});

export const TON_FINANCIAL_SCHEMA_VERSION = 1;

/**
 * Record types that are immutable immediately on create.
 */
export const IMMUTABLE_ON_CREATE_TYPES = Object.freeze([
    TON_FINANCIAL_RECORD_TYPES.SNAPSHOT,
    TON_FINANCIAL_RECORD_TYPES.AUDIT,
    TON_FINANCIAL_RECORD_TYPES.ARCHIVED_CONTRACT
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

export const RECORD_STORAGE_CATEGORY = Object.freeze({
    [TON_FINANCIAL_RECORD_TYPES.GAME_CONTRACT]: "active",
    [TON_FINANCIAL_RECORD_TYPES.PAYMENT_SESSION]: "active",
    [TON_FINANCIAL_RECORD_TYPES.WALLET_SESSION]: "active",
    [TON_FINANCIAL_RECORD_TYPES.SETTLEMENT]: "active",
    [TON_FINANCIAL_RECORD_TYPES.RECOVERY_CHECKPOINT]: "active",
    [TON_FINANCIAL_RECORD_TYPES.SNAPSHOT]: "immutable",
    [TON_FINANCIAL_RECORD_TYPES.AUDIT]: "immutable",
    [TON_FINANCIAL_RECORD_TYPES.ARCHIVED_CONTRACT]: "archived"
});
