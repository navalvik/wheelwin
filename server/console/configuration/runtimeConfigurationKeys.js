/**
 * R17.9G.1 — Editable runtime configuration parameter keys.
 * Wallets are intentionally excluded (read-only infrastructure).
 */

export const RUNTIME_CONFIG_EDITABLE_KEYS = Object.freeze([
    "setupTimeoutMs",
    "countdownDurationMs",
    "brakeDurationMs"
]);
