/**
 * Phase 2 — Read-only incoming TON transfer adapter (isolated).
 *
 * Observation-only layer. It reads provider transaction records, normalizes
 * them, and evaluates possible matches against Phase 1 payment intents. It
 * cannot send, broadcast, sign or retry anything, and it can never mark a
 * payment intent paid or confirmed — observation is not confirmation.
 *
 * No concrete TON provider client is shipped in this phase: the current
 * project configuration identifies no approved read-only TON provider, so
 * only the normalized interface and the mockable provider boundary exist.
 * Nothing here claims live TON compatibility.
 *
 * This module does not modify any Phase 1 file; it only imports from it.
 *
 * Phase 3C adds `PaymentReferenceCodec`: the single strict wire format
 * (`WW1:<paymentReference>`) for a native TON transfer comment. It formats
 * and extracts the Phase 1 payment reference only; it is not a second
 * payment-identity system.
 */

export {
    INCOMING_TRANSFER_SCHEMA_VERSION,
    INCOMING_TRANSFER_DIRECTION,
    INCOMING_TRANSFER_NETWORKS,
    SUPPORTED_INCOMING_TRANSFER_NETWORKS,
    DEFAULT_INCOMING_TRANSFER_NETWORK,
    INCOMING_TRANSACTION_ID_PREFIX,
    INCOMING_TRANSFER_PROVIDER_CONTRACT,
    PAYMENT_CONFIRMATION_DISPOSITION,
    isPaymentConfirmationDisposition,
    INCOMING_TRANSFER_ADAPTER_CAPABILITIES,
    TRANSFER_REJECTION_REASON,
    TRANSFER_MATCH_REASON
} from "./IncomingTransferConstants.js";

export {
    IncomingTransferError,
    ProviderContractError,
    ProviderResponseError,
    ProviderRequestError,
    ProviderOperationBlockedError,
    TransactionIdentityError,
    TransactionRecordIncompleteError,
    TransactionRecordRejectedError,
    SecretBearingRecordError,
    ObservationConflictError,
    AmbiguousTransferMatchError
} from "./IncomingTransferErrors.js";

export {
    normalizeNetwork,
    isSupportedNetwork,
    deriveIncomingTransactionId,
    parseAtomicAmount,
    parseTransactionTime
} from "./IncomingTransferIdentity.js";

export {
    TON_ADDRESS_TAG,
    TON_ADDRESS_FORM,
    TON_FRIENDLY_ENCODING,
    TonAddressIdentityError,
    parseTonAddress,
    deriveTonAddressIdentity,
    tonAddressIdentityOrNull,
    tonAddressIdentitiesEqual,
    isCanonicalTonAddressIdentity
} from "./TonAddressIdentity.js";

export {
    PAYMENT_REFERENCE_COMMENT_PREFIX,
    PAYMENT_REFERENCE_PATTERN,
    PAYMENT_REFERENCE_MAX_LENGTH,
    PAYMENT_REFERENCE_REJECTION_REASON,
    PaymentReferenceFormatError,
    isPaymentReference,
    formatPaymentReference,
    inspectPaymentReferenceComment,
    extractPaymentReference,
    isPaymentReferenceComment
} from "./PaymentReferenceCodec.js";

export { IncomingTransfer } from "./IncomingTransfer.js";

export {
    IncomingTransferProviderClient,
    assertReadOnlyProviderClient,
    assertNoOperations,
    INCOMING_TRANSFER_ADAPTER_FORBIDDEN_OPERATIONS
} from "./IncomingTransferProvider.js";

export {
    normalizeIncomingTransferRecord,
    defaultPaymentReferenceExtractor
} from "./IncomingTransferNormalizer.js";

export {
    IncomingTransferObservationLedger
} from "./IncomingTransferObservationLedger.js";

export {
    matchIncomingTransferToIntent,
    resolveIncomingTransferMatch,
    resolveIncomingTransferMatches
} from "./IncomingTransferMatcher.js";

export { IncomingTransferAdapter } from "./IncomingTransferAdapter.js";
