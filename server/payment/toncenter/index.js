/**
 * Phase 3 — Toncenter Testnet read-only provider (isolated).
 *
 * Observation-only integration for the official Testnet API v3
 * (`https://testnet.toncenter.com/api/v3/transactions`), built on the Phase 2
 * incoming-transfer schema and matcher. Responsibilities:
 *
 *   - `ToncenterTransactionsClient` — one documented read-only GET per call,
 *     authenticated with the single existing TON_API_KEY runtime variable,
 *     never retried, never polling;
 *   - `ToncenterTransactionsMapper` — v3 response -> Phase 2 provider records,
 *     extracting a payment reference only from the documented `text_comment`
 *     body carrying exactly `WW1:<paymentReference>`;
 *   - `ToncenterIncomingProvider` — the Phase 2 read-only provider contract;
 *   - `ToncenterRateLimiter` — one shared, configurable limiter
 *     (default 8 requests/second, below the documented Free-plan ceiling of
 *     10; exceeding 10 requires an explicitly verified subscription plan);
 *   - `RoomPaymentObservationService` — caller-driven room checks: one
 *     request per explicit check, coalesced for simultaneous checks of the
 *     same room/wallet, no background scheduling of any kind.
 *
 * Nothing here can send, broadcast or sign a transaction, read a wallet
 * balance as a payment substitute, or mark a payment intent paid or
 * confirmed. The subscription tier is not verified by this project; no live
 * compatibility beyond the documented contract is claimed.
 *
 * Phase 1 and Phase 2 files are imported, never modified.
 */

export {
    TONCENTER_TESTNET_BASE_URL,
    TONCENTER_TRANSACTIONS_PATH,
    TONCENTER_MASTERCHAIN_INFO_PATH,
    TONCENTER_STREAMING_V2_SSE_PATH,
    TONCENTER_API_KEY_ENV_VAR,
    TONCENTER_PROVIDER_ID,
    TONCENTER_NETWORK,
    TONCENTER_ASSET,
    TONCENTER_TEXT_COMMENT_DECODED_TYPE,
    TONCENTER_MAX_TRANSACTION_LIMIT,
    TONCENTER_DEFAULT_TRANSACTION_LIMIT,
    TONCENTER_DOCUMENTED_FREE_PLAN_RPS,
    TONCENTER_DEFAULT_MAX_REQUESTS_PER_SECOND,
    TONCENTER_DEFAULT_TIMEOUT_MS,
    TONCENTER_PROVIDER_CONTRACT_VERSION
} from "./ToncenterConstants.js";

export {
    ToncenterError,
    ToncenterApiKeyMissingError,
    ToncenterAuthenticationError,
    ToncenterRateLimitError,
    ToncenterServiceError,
    ToncenterRequestError,
    ToncenterResponseError
} from "./ToncenterErrors.js";

export {
    ToncenterTransactionsClient,
    defaultApiKeyProvider
} from "./ToncenterTransactionsClient.js";

export { ToncenterFinalityEvidenceProvider } from "./ToncenterFinalityEvidenceProvider.js";

export {
    mapToncenterTransactionsResponse,
    resolveAddress
} from "./ToncenterTransactionsMapper.js";

export {
    ToncenterRateLimiter,
    assertToncenterRateConfiguration
} from "./ToncenterRateLimiter.js";

export { ToncenterIncomingProvider } from "./ToncenterIncomingProvider.js";

export {
    RoomPaymentObservationService,
    isTrustedRoomPaymentObservationResult,
    hasTrustedRoomPaymentSettlementEvidence
} from "./RoomPaymentObservationService.js";

export {
    TON_TESTNET_GLOBAL_ID,
    TON_SETTLEMENT_EVIDENCE_POLICY,
    TonPaymentSettlementEvidenceProvider,
    assessTonPaymentSettlementEvidence,
    assertTonPaymentSettlementEvidence
} from "../incoming/TonPaymentSettlementEvidence.js";
