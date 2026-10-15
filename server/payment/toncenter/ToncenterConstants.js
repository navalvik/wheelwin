/**
 * Phase 3 — Toncenter Testnet read-only provider: fixed constants.
 *
 * Endpoint and contract facts below come from the official Toncenter v3
 * OpenAPI specification (https://testnet.toncenter.com/api/v3/doc.json),
 * verified against the documented `GET /api/v3/transactions` operation:
 *
 *   - security: `X-Api-Key` request header (HTTP header names are
 *     case-insensitive; this module sends `X-API-Key`)
 *   - query:    account (any form), start_utime / end_utime (int32 seconds),
 *               limit (1..1000, default 10), offset, sort (asc|desc by lt)
 *   - response: { transactions: [Transaction...], address_book: { raw -> row } }
 *   - Transaction.now is an epoch-SECONDS generation timestamp; message text
 *     comments live at `in_msg.message_content.decoded.comment` with
 *     `decoded.type === "text_comment"`; `address_book` maps a raw address to
 *     its `user_friendly` form.
 *
 * The API key is read from the single existing runtime environment variable
 * TON_API_KEY. No second key variable exists and no secret is stored here.
 */

/** Official Toncenter Testnet base URL. */
export const TONCENTER_TESTNET_BASE_URL = "https://testnet.toncenter.com";

/** Documented v3 transactions path. */
export const TONCENTER_TRANSACTIONS_PATH = "/api/v3/transactions";

/** Read-only v3 masterchain identity endpoint. */
export const TONCENTER_MASTERCHAIN_INFO_PATH = "/api/v3/masterchainInfo";

/** Testnet Streaming API v2 server-sent events endpoint. */
export const TONCENTER_STREAMING_V2_SSE_PATH = "/api/streaming/v2/sse";

/**
 * The single existing runtime environment variable holding the API key.
 * A second key variable must never be introduced.
 */
export const TONCENTER_API_KEY_ENV_VAR = "TON_API_KEY";

/** Provider identity tag used for Phase 2 transaction-id derivation. */
export const TONCENTER_PROVIDER_ID = "toncenter";

/** Network identifier, matching the Phase 1 default network. */
export const TONCENTER_NETWORK = "testnet";

/** Native TON asset identifier, matching the Phase 1 payment core. */
export const TONCENTER_ASSET = "TON";

/**
 * The ONLY documented `in_msg.message_content.decoded` type this provider
 * accepts as a payment reference. Every other decoded type (binary comment,
 * contract payload, opcode, encrypted payload) is ignored: it is never
 * interpreted as a payment reference, and its text is never read.
 */
export const TONCENTER_TEXT_COMMENT_DECODED_TYPE = "text_comment";

/**
 * Documented maximum `limit` for /api/v3/transactions (OpenAPI `maximum`).
 */
export const TONCENTER_MAX_TRANSACTION_LIMIT = 1000;

/**
 * Bounded default page size for one room check. One room check performs at
 * most ONE request, so the page size bounds the observation window; the
 * service reports a potentially incomplete window instead of silently
 * declaring that no payment exists.
 */
export const TONCENTER_DEFAULT_TRANSACTION_LIMIT = 50;

/**
 * Documented Toncenter Free-plan rate ceiling: 10 requests/second.
 * The current subscription tier is NOT verified by this project, so this is
 * treated as the only confirmed quota and never as a licence to exceed it.
 */
export const TONCENTER_DOCUMENTED_FREE_PLAN_RPS = 10;

/**
 * Conservative authenticated default: 8 requests/second, deliberately below
 * the documented Free-plan ceiling of 10 requests/second. A higher rate is
 * allowed only through an explicit configuration change that matches a
 * VERIFIED subscription plan.
 */
export const TONCENTER_DEFAULT_MAX_REQUESTS_PER_SECOND = 8;

/** Default per-request timeout (milliseconds). */
export const TONCENTER_DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Phase 2 read-only provider contract identifier implemented by
 * `ToncenterIncomingProvider`.
 */
export const TONCENTER_PROVIDER_CONTRACT_VERSION = 1;
