/**
 * Phase 2 — Read-only incoming TON transfer adapter: fixed constants.
 *
 * Phase 2 is observation-only. Nothing in this module mutates a payment
 * intent, credits a transaction, marks a payment paid/confirmed, or performs
 * any blockchain write operation.
 *
 * Networks below mirror the Phase 1 default network
 * (`DEFAULT_ROOM_WALLET_NETWORK`). An unlisted network is an unsupported
 * transaction record and is rejected — never guessed.
 */

import { DEFAULT_ROOM_WALLET_NETWORK } from "../RoomPaymentConstants.js";

/**
 * Durable-storage identity for normalized incoming-transfer observations.
 * The adapter itself never persists anything in Phase 2.
 */
export const INCOMING_TRANSFER_SCHEMA_VERSION = 1;

/**
 * Transfer direction accepted by this adapter. Everything else (outgoing,
 * internal-only bookkeeping, provider-specific message types) is rejected:
 * a provider client must map its own vocabulary onto this declared contract.
 */
export const INCOMING_TRANSFER_DIRECTION = "incoming";

/** Networks this adapter is allowed to normalize. */
export const INCOMING_TRANSFER_NETWORKS = Object.freeze({
    TESTNET: "testnet",
    MAINNET: "mainnet"
});

export const SUPPORTED_INCOMING_TRANSFER_NETWORKS = Object.freeze([
    INCOMING_TRANSFER_NETWORKS.TESTNET,
    INCOMING_TRANSFER_NETWORKS.MAINNET
]);

/** The default observation network, aligned with Phase 1. */
export const DEFAULT_INCOMING_TRANSFER_NETWORK = DEFAULT_ROOM_WALLET_NETWORK;

/**
 * Prefix of every deterministic transaction identifier produced by this
 * adapter. Identifiers without this prefix are never accepted as adapter
 * identities (they cannot have been derived by `deriveIncomingTransactionId`).
 */
export const INCOMING_TRANSACTION_ID_PREFIX = "ttx_";

/**
 * Declared, provider-independent contract between the adapter and an injected
 * read-only provider client.
 *
 * This is NOT an endpoint schema: it is the exact record shape a provider
 * client must present after doing its own transport work. No live TON
 * provider has been approved in the current project configuration, so this
 * contract is untested against any real provider response and must not be
 * treated as live-compatible until verified against one.
 */
export const INCOMING_TRANSFER_PROVIDER_CONTRACT = Object.freeze({
    interfaceName: "IncomingTransferProviderClient",
    contractVersion: 1,
    readonly: true,
    operation: "listIncomingTransactions",
    /**
     * Operations a provider client must never expose for the adapter to
     * accept it. The adapter refuses such clients instead of attempting to
     * use a read-only subset.
     */
    forbiddenOperations: Object.freeze([
        "sendTransaction",
        "sendTransactions",
        "sendBoc",
        "sendExternalMessage",
        "broadcast",
        "broadcastTransaction",
        "submitTransaction",
        "sign",
        "signTransaction",
        "signMessage",
        "deploy",
        "deployContract",
        "call",
        "callContract",
        "transfer",
        "transferTon",
        "burn"
    ]),
    requiredRecordFields: Object.freeze([
        "network",
        "accountId",
        "transactionId",
        "transactionTime",
        "sourceAddress",
        "destinationAddress",
        "amountAtomic",
        "asset"
    ]),
    optionalRecordFields: Object.freeze([
        "direction",
        "destinationWalletId",
        "comment",
        "confirmed",
        "aborted"
    ]),
    /**
     * Field names that must never appear in a provider record handed to the
     * adapter. A record carrying any of them is rejected as contradictory.
     */
    forbiddenRecordFields: Object.freeze([
        "secretKey",
        "secret",
        "privateKey",
        "mnemonic",
        "seed",
        "passphrase"
    ])
});

/**
 * The only disposition any Phase 2 observation can carry. Observing a
 * provider transaction is NOT a payment confirmation.
 */
export const PAYMENT_CONFIRMATION_DISPOSITION = Object.freeze({
    OBSERVATION_ONLY: "observation-only"
});

/**
 * Always false in Phase 2: no observation disposition produced by this adapter
 * is a payment confirmation. The parameter is accepted (and ignored) so that
 * callers can gate confirmation logic through a single, structurally safe
 * helper instead of re-implementing the rule.
 */
export function isPaymentConfirmationDisposition(/* disposition */) {

    return false;

}

/** Capabilities the adapter implements — and, by omission, does not. */
export const INCOMING_TRANSFER_ADAPTER_CAPABILITIES = Object.freeze([
    "observe-incoming-transactions",
    "normalize-provider-transaction-record",
    "evaluate-single-intent-match",
    "resolve-match-against-intents",
    "detect-replayed-transaction-identity"
]);

/**
 * Machine-readable rejection reasons for a normalized incoming transfer.
 */
export const TRANSFER_REJECTION_REASON = Object.freeze({
    RECORD_FIELDS_INCOMPLETE: "RECORD_FIELDS_INCOMPLETE",
    RECORD_CONTRADICTORY: "RECORD_CONTRADICTORY",
    NETWORK_UNSUPPORTED: "NETWORK_UNSUPPORTED",
    DIRECTION_UNSUPPORTED: "DIRECTION_UNSUPPORTED",
    AMOUNT_NOT_EXACT_INTEGER: "AMOUNT_NOT_EXACT_INTEGER",
    TRANSACTION_TIME_INVALID: "TRANSACTION_TIME_INVALID"
});

/**
 * Machine-readable reasons why a normalized incoming transfer does not match
 * a payment intent. A non-match is never an error — it is a refusal to credit.
 */
export const TRANSFER_MATCH_REASON = Object.freeze({
    NETWORK_MISMATCH: "NETWORK_MISMATCH",
    DESTINATION_ADDRESS_MISMATCH: "DESTINATION_ADDRESS_MISMATCH",
    DESTINATION_ADDRESS_INVALID: "DESTINATION_ADDRESS_INVALID",
    DESTINATION_WALLET_ID_MISMATCH: "DESTINATION_WALLET_ID_MISMATCH",
    SENDER_MISMATCH: "SENDER_MISMATCH",
    SENDER_ADDRESS_INVALID: "SENDER_ADDRESS_INVALID",
    AMOUNT_MISMATCH: "AMOUNT_MISMATCH",
    ASSET_MISMATCH: "ASSET_MISMATCH",
    PAYMENT_REFERENCE_MISSING: "PAYMENT_REFERENCE_MISSING",
    PAYMENT_REFERENCE_MISMATCH: "PAYMENT_REFERENCE_MISMATCH",
    INTENT_NOT_MATCHABLE: "INTENT_NOT_MATCHABLE",
    INTENT_ALREADY_MATCHED: "INTENT_ALREADY_MATCHED",
    NO_INTENT_MATCH: "NO_INTENT_MATCH"
});
