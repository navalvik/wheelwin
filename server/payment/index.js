/**
 * Phase 1 — Room Wallet Payment Layer (isolated, server-side).
 *
 * This module is deliberately self-contained:
 *   - no smart contracts / escrow / deposit / deployment architecture (R9)
 *   - no blockchain execution, broadcast or retry (security scope)
 *   - no real Testnet / Mainnet payment collection (security scope)
 *   - no restored historical financial code
 *   - no wallet secret material is ever read, retained or written
 *
 * Durability: file-backed JSON storage under `dataDir`, matching the existing
 * server storage convention.
 */

export {
    ROOM_LIFETIME_MS,
    ROOM_WALLET_POOL_SIZE,
    DEFAULT_ROOM_WALLET_NETWORK,
    PAYMENT_INTENT_SCHEMA_VERSION,
    WALLET_POOL_SCHEMA_VERSION
} from "./RoomPaymentConstants.js";

export {
    PAYMENT_INTENT_STATE,
    PAYMENT_INTENT_STATES,
    PAYMENT_INTENT_TRANSITIONS,
    TERMINAL_PAYMENT_INTENT_STATES,
    OBLIGATION_OPEN_STATES,
    isPaymentIntentState,
    isTerminalPaymentIntentState,
    isObligationOpen,
    canTransition
} from "./PaymentIntentStatus.js";

export {
    RoomDeadline,
    createRoomDeadline
} from "./RoomDeadline.js";

export {
    PaymentIntent,
    assertAtomicAmount
} from "./PaymentIntent.js";

export {
    AssetDenomination,
    AssetDenominationRegistry
} from "./AssetDenomination.js";

export {
    RoomWallet,
    WalletPoolRegistry,
    resolveDefaultRoomWalletCatalogPath,
    readRoomWalletCatalog,
    atomicWriteJson
} from "./WalletPoolRegistry.js";

export {
    PaymentIntentStore,
    PAYMENT_INTENT_STORAGE_SCHEMA_VERSION
} from "./PaymentIntentStore.js";

export {
    isPaymentIntentStoreContract
} from "./PaymentIntentStoreContract.js";

export {
    RoomWalletPaymentService,
    ROOM_WALLET_PAYMENT_PHASE
} from "./RoomWalletPaymentService.js";

export {
    PaymentError,
    PaymentConfigurationError,
    PaymentReferenceCollisionError,
    PaymentIntentExpiredError,
    InvalidPaymentStateTransitionError,
    WalletAssignmentConflictError,
    WalletPoolExhaustedError,
    WalletRecyclingBlockedError,
    TransactionAlreadyCreditedError,
    PaymentExecutionBlockedError,
    PaymentStorageError,
    CorruptedPaymentRecordError,
    PaymentIntentNotFoundError,
    PaymentValidationError
} from "./PaymentErrors.js";
