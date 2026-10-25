/**
 * Phase 1 — Room Wallet Payment Core: fixed constants.
 *
 * IMPORTANT: the 300s room lifetime below is a *read-only mirror* of the
 * authoritative room lifetime used for payment-intent deadline computation.
 * It does NOT start, restart, extend, or otherwise influence any existing room
 * timer, Setup Session timer, or game-stage transition.
 */

/**
 * R1 — Immutable room lifetime. Exactly 300 seconds from room creation.
 *
 * Payment intents derive their absolute expiration from this value:
 *   deadlineMs = roomCreatedAt + ROOM_LIFETIME_MS
 */
export const ROOM_LIFETIME_MS = 300_000;

/**
 * R2 — Number of server-controlled game wallets in the room wallet pool.
 */
export const ROOM_WALLET_POOL_SIZE = 64;

/** Default network identifier for the room wallet pool. */
export const DEFAULT_ROOM_WALLET_NETWORK = "testnet";

/**
 * Durable-storage identity for persisted payment intents.
 */
export const PAYMENT_INTENT_SCHEMA_VERSION = 1;

/**
 * Durable-storage identity for persisted wallet-pool registry snapshots.
 */
export const WALLET_POOL_SCHEMA_VERSION = 1;
