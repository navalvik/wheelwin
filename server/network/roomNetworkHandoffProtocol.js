/**
 * R21 — Cross-runtime room network handoff contract constants.
 *
 * Shared between:
 * - the Testnet-side internal HTTP routes (record owner), and
 * - the Mainnet-side HTTP client (caller).
 *
 * This is server-to-server production infrastructure. It must never be
 * exposed to the browser client and must never live under /console/* or
 * /debug/*.
 */

/** Dedicated shared-secret header (never a console credential, bot token or wallet secret). */
export const ROOM_NETWORK_HANDOFF_SECRET_HEADER =
    "x-wheelwin-network-handoff-secret";

/** Dedicated shared-secret environment variable (Testnet and Mainnet must match). */
export const ROOM_NETWORK_HANDOFF_SECRET_ENV = "ROOM_NETWORK_HANDOFF_SECRET";

/** Mainnet-side environment variable pointing at the Testnet base URL. */
export const ROOM_NETWORK_HANDOFF_TESTNET_URL_ENV =
    "ROOM_NETWORK_HANDOFF_TESTNET_URL";

/** Internal Testnet endpoints (same semantic contract; no /console or /debug surface). */
export const NETWORK_HANDOFF_ENDPOINTS = Object.freeze({
    CLAIM: "/internal/network-handoff/claim",
    COMPLETE: "/internal/network-handoff/complete"
});

/** Machine-readable reason codes exposed by the Testnet handoff contract. */
export const NETWORK_HANDOFF_REASONS = Object.freeze({
    UNAUTHORIZED: "UNAUTHORIZED",
    HANDOFF_NOT_CONFIGURED: "HANDOFF_NOT_CONFIGURED",
    INVALID_REQUEST: "INVALID_REQUEST",
    FORBIDDEN_FIELD: "FORBIDDEN_FIELD",
    NOT_FOUND_OR_EXPIRED: "NOT_FOUND_OR_EXPIRED",
    OWNER_MISMATCH: "OWNER_MISMATCH",
    CLAIM_REQUIRED: "CLAIM_REQUIRED",
    INVALID_MAINNET_ROOM_ID: "INVALID_MAINNET_ROOM_ID"
});
