/**
 * R17.9G.1 — Editable runtime configuration parameter keys.
 * Wallets are intentionally excluded (read-only infrastructure).
 */

export const RUNTIME_CONFIG_EDITABLE_KEYS = Object.freeze([
    "setupTimeoutMs",
    "paymentTimeoutMs",
    "countdownDurationMs",
    "brakeDurationMs",
    "settlementTimeoutMs",
    "baseStake1Gram",
    "baseStake2Gram",
    "ownerFeePercent"
]);

export const DEFAULT_SETTLEMENT_TIMEOUT_MS = 10 * 60 * 1000;
