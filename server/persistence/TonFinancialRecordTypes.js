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
    AUDIT: "audit",
    // R17.8V.2P.H — immutable deploy economics fact (mutable until FROZEN).
    DEPLOYMENT_COST_SNAPSHOT: "deployment_cost_snapshot",
    // R17.8V.2P.M — operational reimbursement queue (no chain send in Stage M).
    DEPLOYMENT_REIMBURSEMENT: "deployment_reimbursement"
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

/** R17.8V.2P.H — terminal statuses that freeze deployment_cost_snapshot envelopes. */
export const DEPLOYMENT_COST_SNAPSHOT_TERMINAL_STATUSES = Object.freeze([
    "FROZEN"
]);

/** R17.8V.2P.M / P — terminal reimbursement statuses (immutable envelopes). */
export const DEPLOYMENT_REIMBURSEMENT_TERMINAL_STATUSES = Object.freeze([
    "CONFIRMED",
    "CANCELLED",
    "FAILED_TERMINAL"
]);

export const RECORD_STORAGE_CATEGORY = Object.freeze({
    [TON_FINANCIAL_RECORD_TYPES.GAME_CONTRACT]: "active",
    [TON_FINANCIAL_RECORD_TYPES.PAYMENT_SESSION]: "active",
    [TON_FINANCIAL_RECORD_TYPES.WALLET_SESSION]: "active",
    [TON_FINANCIAL_RECORD_TYPES.SETTLEMENT]: "active",
    [TON_FINANCIAL_RECORD_TYPES.RECOVERY_CHECKPOINT]: "active",
    [TON_FINANCIAL_RECORD_TYPES.DEPLOYMENT_COST_SNAPSHOT]: "active",
    [TON_FINANCIAL_RECORD_TYPES.DEPLOYMENT_REIMBURSEMENT]: "active",
    [TON_FINANCIAL_RECORD_TYPES.SNAPSHOT]: "immutable",
    [TON_FINANCIAL_RECORD_TYPES.AUDIT]: "immutable",
    [TON_FINANCIAL_RECORD_TYPES.ARCHIVED_CONTRACT]: "archived"
});
