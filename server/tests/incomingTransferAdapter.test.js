/**
 * Phase 2 — Read-only incoming TON transfer adapter (ISOLATED).
 *
 * Fully self-contained: the only provider is a synthetic in-test mock that
 * returns fixture data from memory. No network, node, endpoint, credential or
 * real wallet is ever contacted, and no `.env` / wallet-secret file is read or
 * modified.
 *
 * Covered scenarios (per Phase 2 scope):
 *   1. Valid incoming transfer normalization
 *   2. Exact integer amount handling without floating-point conversion
 *   3. Network and destination validation
 *   4. Missing or malformed transaction identity
 *   5. Missing or duplicate payment reference
 *   6. Correct unique match against a payment intent
 *   7. Wrong sender, destination, network, asset or amount
 *   8. A transaction that would match multiple intents
 *   9. Replay of the same provider transaction identity
 *  10. Provider error, malformed provider response, incomplete transaction data
 *  11. Explicit proof that the adapter cannot send or broadcast transactions
 *      and does not mark an intent confirmed
 *  12. Canonical TON address identity matching (raw ↔ friendly)
 *  13. Native TON payment reference codec (Phase 3C): the strict
 *      `WW1:<paymentReference>` comment format and its Phase 1 interop
 *
 * Fixtures below are synthetic test data. They are not payments, not payment
 * confirmations, and not references to any real wallet or transfer.
 *
 * Project convention: plain ESM + a manual `assert` harness; no test framework
 * and no external dependencies are required.
 */

import * as paymentReferenceCodec from "../payment/incoming/PaymentReferenceCodec.js";

import {
    INCOMING_TRANSFER_ADAPTER_CAPABILITIES,
    INCOMING_TRANSFER_ADAPTER_FORBIDDEN_OPERATIONS,
    INCOMING_TRANSFER_PROVIDER_CONTRACT,
    PAYMENT_CONFIRMATION_DISPOSITION,
    PAYMENT_REFERENCE_COMMENT_PREFIX,
    PAYMENT_REFERENCE_MAX_LENGTH,
    PAYMENT_REFERENCE_REJECTION_REASON,
    TRANSFER_MATCH_REASON,
    TRANSFER_REJECTION_REASON,
    IncomingTransferAdapter,
    IncomingTransfer,
    IncomingTransferProviderClient,
    PaymentReferenceFormatError,
    assertNoOperations,
    assertReadOnlyProviderClient,
    defaultPaymentReferenceExtractor,
    deriveIncomingTransactionId,
    extractPaymentReference,
    formatPaymentReference,
    inspectPaymentReferenceComment,
    isPaymentConfirmationDisposition,
    isPaymentReference,
    isPaymentReferenceComment,
    matchIncomingTransferToIntent,
    normalizeIncomingTransferRecord,
    resolveIncomingTransferMatch
} from "../payment/incoming/index.js";

import { PaymentIntent } from "../payment/index.js";

// ---------------------------------------------------------------------------
// Minimal assertion harness (project convention)
// ---------------------------------------------------------------------------

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

let checksPassed = 0;

function check(condition, message) {

    assert(condition, message);

    checksPassed += 1;

}

function expectThrow(fn, expectedName, message) {

    let thrown = null;

    try {

        fn();

    } catch (error) {

        thrown = error;

    }

    assert(
        thrown !== null,
        `${message} (expected ${expectedName}, nothing thrown)`
    );

    assert(
        thrown?.name === expectedName,
        `${message} (expected ${expectedName}, got ${thrown?.name}: ${thrown?.message})`
    );

    return thrown;

}

// ---------------------------------------------------------------------------
// Synthetic provider fixtures (test data only — not real payments)
// ---------------------------------------------------------------------------

const FIXTURE_NETWORK = "testnet";
const FIXTURE_PROVIDER_ID = "synthetic-readonly-provider";
const FIXTURE_ACCOUNT_ID = "acct-room-wallet-001";
const FIXTURE_TRANSACTION_ID = "synthetic-tx-0001";
const FIXTURE_TRANSACTION_TIME = 1_700_000_123_000;

/**
 * Synthetic TON account fixtures with correctly computed CRC16/XMODEM
 * checksums (synthetic test data only). The room wallet and the sender are
 * each known in several representations: raw `workchain:hash`, bounceable
 * friendly (`EQ…`), non-bounceable friendly (`UQ…`) and standard base64.
 */
const FIXTURE_SENDER = "EQCODRucKj9OXWx7ip8OHSw7jg0bnCo_Tl1se4qfDh0sO2Yb";
const FIXTURE_SENDER_RAW = "0:8e0d1b9c2a3f4e5d6c7b8a9f0e1d2c3b8e0d1b9c2a3f4e5d6c7b8a9f0e1d2c3b";
const FIXTURE_SENDER_UQ = "UQCODRucKj9OXWx7ip8OHSw7jg0bnCo_Tl1se4qfDh0sOzve";
const FIXTURE_SENDER_UQ_STANDARD = "UQCODRucKj9OXWx7ip8OHSw7jg0bnCo/Tl1se4qfDh0sOzve";

const FIXTURE_DESTINATION = "EQCfHi08S1ppeIeWpbTD0uHwnx4tPEtaaXiHlqW0w9Lh8AKu";
const FIXTURE_DESTINATION_RAW = "0:9f1e2d3c4b5a69788796a5b4c3d2e1f09f1e2d3c4b5a69788796a5b4c3d2e1f0";
const FIXTURE_DESTINATION_UQ = "UQCfHi08S1ppeIeWpbTD0uHwnx4tPEtaaXiHlqW0w9Lh8F9r";
const FIXTURE_DESTINATION_UQ_STANDARD = "UQCfHi08S1ppeIeWpbTD0uHwnx4tPEtaaXiHlqW0w9Lh8F9r";
/** Same account hash as the room wallet, different (negative) workchain. */
const FIXTURE_DESTINATION_OTHER_WORKCHAIN = "Ef-fHi08S1ppeIeWpbTD0uHwnx4tPEtaaXiHlqW0w9Lh8P3m";

/** A different wallet account and a different sender account. */
const FIXTURE_OTHER_WALLET = "EQARIjNEVWZ3iJkAqrvM3e7_ESIzRFVmd4iZAKq7zN3u_5oS";
const FIXTURE_OTHER_SENDER = "EQDB0uP0BRYnOMHS4_QFFic4wdLj9AUWJzjB0uP0BRYnOB7D";

/** Same length as a valid friendly address but with an invalid checksum. */
const FIXTURE_BAD_CHECKSUM_ADDRESS = "EQCfHi08S1ppeIeWpbTD0uHwnx4tPEtaaXiHlqW0w9Lh8AAA";
/** Fabricated text that merely starts with EQ. */
const FIXTURE_FABRICATED_ADDRESS = "EQSyntheticRoomWallet001_________________________";
const FIXTURE_WALLET_ID = "room-wallet-001";
const FIXTURE_ASSET = "TON";
const FIXTURE_AMOUNT_ATOMIC = "1000000000";
const FIXTURE_PAYMENT_REFERENCE = "SYNTHETIC-REF-0001";

/**
 * One synthetic provider transaction record, conforming to
 * INCOMING_TRANSFER_PROVIDER_CONTRACT. All values are invented for tests.
 */
function providerRecord(overrides = {}) {

    return {
        network: FIXTURE_NETWORK,
        accountId: FIXTURE_ACCOUNT_ID,
        transactionId: FIXTURE_TRANSACTION_ID,
        transactionTime: FIXTURE_TRANSACTION_TIME,
        sourceAddress: FIXTURE_SENDER,
        destinationAddress: FIXTURE_DESTINATION,
        amountAtomic: FIXTURE_AMOUNT_ATOMIC,
        asset: FIXTURE_ASSET,
        direction: "incoming",
        destinationWalletId: FIXTURE_WALLET_ID,
        comment: FIXTURE_PAYMENT_REFERENCE,
        confirmed: true,
        aborted: false,
        ...overrides
    };

}

/**
 * Synthetic read-only provider client. It answers from an in-memory array and
 * records how it was called. It cannot send anything.
 *
 * `response` is honoured only when the key is present, so a provider that
 * literally replies `undefined` is distinguishable from one whose fixture was
 * left unset.
 */
function mockProviderClient(records = [providerRecord()], options = {}) {

    const calls = [];

    return {
        calls,
        listIncomingTransactions(listOptions) {

            calls.push({ listOptions });

            if (options.failWith) {

                throw options.failWith;

            }

            return Object.prototype.hasOwnProperty.call(options, "response")
                ? options.response
                : records;

        }
    };

}

/**
 * Synthetic provider client whose reply changes between calls, so replay and
 * contradiction scenarios can be driven without any persistence.
 */
function scriptedProviderClient(recordSets) {

    const calls = [];

    let index = 0;

    return {
        calls,
        listIncomingTransactions(listOptions) {

            calls.push({ listOptions });

            const records = recordSets[Math.min(index, recordSets.length - 1)];

            index += 1;

            return records;

        }
    };

}

/** Adapter over a synthetic provider client. */
function buildAdapter(overrides = {}) {

    const providerClient = overrides.providerClient
        ?? mockProviderClient(overrides.records ?? [providerRecord()]);

    return new IncomingTransferAdapter({
        providerClient,
        network: FIXTURE_NETWORK,
        providerId: FIXTURE_PROVIDER_ID,
        nowProvider: () => FIXTURE_TRANSACTION_TIME + 60_000,
        ...overrides
    });

}

/** Phase 1 payment intent matching the synthetic fixture transaction. */
function buildIntent(overrides = {}) {

    return new PaymentIntent({
        paymentReference: FIXTURE_PAYMENT_REFERENCE,
        roomId: "room-synthetic-001",
        playerId: "player-synthetic-001",
        network: FIXTURE_NETWORK,
        destinationWalletId: FIXTURE_WALLET_ID,
        destinationWalletAddress: FIXTURE_DESTINATION,
        expectedSender: FIXTURE_SENDER,
        amountAtomic: Number(FIXTURE_AMOUNT_ATOMIC),
        asset: FIXTURE_ASSET,
        createdAt: 1_700_000_000_000,
        expiresAt: 1_700_000_100_000,
        roomDeadlineMs: 1_700_000_480_000,
        ...overrides
    });

}

// ---------------------------------------------------------------------------
// Group 1 — valid incoming transfer normalization
// ---------------------------------------------------------------------------

{

    const transfer = normalizeIncomingTransferRecord(providerRecord(), {
        network: FIXTURE_NETWORK,
        providerId: FIXTURE_PROVIDER_ID,
        now: FIXTURE_TRANSACTION_TIME + 60_000
    });

    check(transfer instanceof IncomingTransfer, "record must normalize to an IncomingTransfer");
    check(transfer.schemaVersion === 1, "normalized schema version must be 1");
    check(transfer.network === "testnet", "network must be normalized to testnet");
    check(transfer.direction === "incoming", "direction must be incoming");
    check(transfer.destinationWalletAddress === FIXTURE_DESTINATION, "destination wallet address must be preserved");
    check(transfer.destinationWalletId === FIXTURE_WALLET_ID, "destination wallet id must be preserved");
    check(transfer.senderAddress === FIXTURE_SENDER, "sender address must be preserved");
    check(transfer.asset === FIXTURE_ASSET, "asset must be preserved");
    check(transfer.transactionTime === FIXTURE_TRANSACTION_TIME, "transaction time must be preserved");
    check(transfer.paymentReference === FIXTURE_PAYMENT_REFERENCE, "payment reference must be preserved");
    check(transfer.paymentComment === FIXTURE_PAYMENT_REFERENCE, "payment comment must be preserved");
    check(transfer.providerConfirmed === true, "provider confirmation state must be preserved");
    check(transfer.observedAt === FIXTURE_TRANSACTION_TIME + 60_000, "observation time must be recorded");

    // Raw provider identity is preserved for later idempotency checks.
    check(
        transfer.providerTransactionIdentity.providerId === FIXTURE_PROVIDER_ID
            && transfer.providerTransactionIdentity.accountId === FIXTURE_ACCOUNT_ID
            && transfer.providerTransactionIdentity.transactionId === FIXTURE_TRANSACTION_ID,
        "raw provider transaction identity must be preserved"
    );

    // Derived transaction identity: deterministic, network-scoped.
    check(
        transfer.transactionId === deriveIncomingTransactionId({
            network: FIXTURE_NETWORK,
            providerId: FIXTURE_PROVIDER_ID,
            accountId: FIXTURE_ACCOUNT_ID,
            transactionId: FIXTURE_TRANSACTION_ID
        }),
        "transaction id must equal the derived network-scoped identity"
    );

    check(
        transfer.transactionId.startsWith("ttx_") && transfer.transactionId.length === 68,
        "derived transaction id must be prefixed and fixed-length"
    );

    // Immutability: no caller can silently edit an observation.
    check(Object.isFrozen(transfer), "normalized transfer must be frozen");
    check(Object.isFrozen(transfer.toRecord()), "serialized record must be frozen");
    check(Object.isFrozen(transfer.providerTransactionIdentity), "provider identity must be frozen");

    // Only whitelisted fields are retained: unknown fields from the raw
    // response are dropped silently, never stored.
    const noisy = normalizeIncomingTransferRecord(providerRecord({
        unknownProviderPayload: { deep: "value" },
        providerMetadata: "internal"
    }), {
        network: FIXTURE_NETWORK,
        providerId: FIXTURE_PROVIDER_ID,
        now: FIXTURE_TRANSACTION_TIME
    });

    const serialized = JSON.stringify(noisy.toRecord());

    check(!serialized.includes("unknownProviderPayload"), "unknown provider fields must never be retained");
    check(!serialized.includes("deep"), "unknown provider payloads must never be retained");
    check(!serialized.includes("providerMetadata"), "unknown provider metadata must never be retained");

    check(
        noisy.transactionId === transfer.transactionId
            && noisy.amountAtomic === transfer.amountAtomic
            && noisy.paymentReference === transfer.paymentReference,
        "dropping unknown fields must not change the normalized identity or payload"
    );

    // Default reference extractor.
    check(
        defaultPaymentReferenceExtractor({ comment: "  ref-1  " }) === "ref-1",
        "default extractor must trim the comment"
    );

    check(
        defaultPaymentReferenceExtractor({ comment: "   " }) === null,
        "blank comment must normalize to no reference"
    );

    check(
        defaultPaymentReferenceExtractor({}) === null,
        "absent comment must normalize to no reference"
    );

    console.log("[1/11] valid normalization: PASS");

}

// ---------------------------------------------------------------------------
// Group 2 — exact integer amount handling (no floating point)
// ---------------------------------------------------------------------------

{

    // Providers commonly return amounts as digit strings: exact via BigInt.
    const fromString = normalizeIncomingTransferRecord(
        providerRecord({ amountAtomic: "1000000000" }),
        { network: FIXTURE_NETWORK, providerId: FIXTURE_PROVIDER_ID }
    );

    check(
        fromString.amountAtomic === 1000000000 && Number.isSafeInteger(fromString.amountAtomic),
        "digit-string amount must convert to the exact integer"
    );

    const fromNumber = normalizeIncomingTransferRecord(
        providerRecord({ amountAtomic: 1000000000 }),
        { network: FIXTURE_NETWORK, providerId: FIXTURE_PROVIDER_ID }
    );

    check(fromNumber.amountAtomic === fromString.amountAtomic, "string and integer forms must agree exactly");

    // Large but exact amounts stay exact (no float rounding).
    const maxSafe = "9007199254740991"; // Number.MAX_SAFE_INTEGER

    check(
        normalizeIncomingTransferRecord(providerRecord({ amountAtomic: maxSafe }), {
            network: FIXTURE_NETWORK,
            providerId: FIXTURE_PROVIDER_ID
        }).amountAtomic === 9007199254740991,
        "large exact digit strings must stay exact"
    );

    // Fractional, exponential, signed, zero and out-of-range amounts are rejected.
    for (const [label, badAmount] of [

        ["fractional string", "1000000000.5"],
        ["exponent string", "1e9"],
        ["negative string", "-1000000000"],
        ["zero string", "0"],
        ["unsafe integer string", "9007199254740993"],
        ["oversized string", "100000000000000000000"],
        ["hex string", "0x10"],
        ["float number", 1000000000.5],
        ["zero number", 0],
        ["negative number", -5],
        ["NaN", Number.NaN],
        ["Infinity", Number.POSITIVE_INFINITY],
        ["boolean", true],
        ["object", {}]

    ]) {

        const rejected = expectThrow(
            () => normalizeIncomingTransferRecord(providerRecord({ amountAtomic: badAmount }), {
                network: FIXTURE_NETWORK,
                providerId: FIXTURE_PROVIDER_ID
            }),
            "TransactionRecordRejectedError",
            `amount must be rejected: ${label}`
        );

        check(
            rejected.details.reason === TRANSFER_REJECTION_REASON.AMOUNT_NOT_EXACT_INTEGER,
            `${label} must report AMOUNT_NOT_EXACT_INTEGER`
        );

    }

    // The observation path keeps the same exactness guarantee.
    const adapter = buildAdapter({ records: [providerRecord({ amountAtomic: "1000000000" })] });
    const observation = adapter.observeIncomingTransactions();

    check(
        observation.observed[0].amountAtomic === 1000000000
            && Number.isInteger(observation.observed[0].amountAtomic),
        "observed amount must be an exact integer"
    );

    console.log("[2/11] exact integer amounts: PASS");

}

// ---------------------------------------------------------------------------
// Group 3 — network and destination validation
// ---------------------------------------------------------------------------

{

    // Unsupported networks are rejected, never guessed.
    const unsupported = expectThrow(
        () => normalizeIncomingTransferRecord(providerRecord({ network: "testnet2" }), {
            network: FIXTURE_NETWORK,
            providerId: FIXTURE_PROVIDER_ID
        }),
        "TransactionRecordRejectedError",
        "unsupported network must be rejected"
    );

    check(
        unsupported.details.reason === TRANSFER_REJECTION_REASON.NETWORK_UNSUPPORTED,
        "unsupported network must report NETWORK_UNSUPPORTED"
    );

    // A record on another network is contradictory for this adapter scope.
    const contradictory = expectThrow(
        () => normalizeIncomingTransferRecord(providerRecord({ network: "mainnet" }), {
            network: FIXTURE_NETWORK,
            providerId: FIXTURE_PROVIDER_ID
        }),
        "TransactionRecordRejectedError",
        "cross-network record must be rejected as contradictory"
    );

    check(
        contradictory.details.reason === TRANSFER_REJECTION_REASON.RECORD_CONTRADICTORY,
        "cross-network record must report RECORD_CONTRADICTORY"
    );

    // A mainnet-scoped adapter normalizes the same mainnet record fine.
    const mainnetTransfer = normalizeIncomingTransferRecord(providerRecord({ network: "MAINNET" }), {
        network: "mainnet",
        providerId: FIXTURE_PROVIDER_ID
    });

    check(mainnetTransfer.network === "mainnet", "network must be normalized to lowercase");

    // Adapter refuses an unsupported configured network.
    expectThrow(
        () => buildAdapter({ network: "testnet2" }),
        "PaymentConfigurationError",
        "adapter must refuse an unsupported network"
    );

    // Missing network / destination fields are incomplete records.
    const incomplete = expectThrow(
        () => normalizeIncomingTransferRecord(providerRecord({ network: undefined }), {
            network: FIXTURE_NETWORK,
            providerId: FIXTURE_PROVIDER_ID
        }),
        "TransactionRecordIncompleteError",
        "missing network must be an incomplete record"
    );

    check(
        incomplete.details.missingFields.includes("network")
            && incomplete.details.reason === TRANSFER_REJECTION_REASON.RECORD_FIELDS_INCOMPLETE,
        "incomplete record must list missing fields"
    );

    for (const field of ["sourceAddress", "destinationAddress", "asset", "accountId", "transactionId", "transactionTime", "amountAtomic"]) {

        expectThrow(
            () => normalizeIncomingTransferRecord(providerRecord({ [field]: undefined }), {
                network: FIXTURE_NETWORK,
                providerId: FIXTURE_PROVIDER_ID
            }),
            "TransactionRecordIncompleteError",
            `missing ${field} must be an incomplete record`
        );

    }

    // Non-string identity fields are rejected as malformed identity.
    const wrongType = expectThrow(
        () => normalizeIncomingTransferRecord(providerRecord({ transactionId: 12345 }), {
            network: FIXTURE_NETWORK,
            providerId: FIXTURE_PROVIDER_ID
        }),
        "TransactionIdentityError",
        "non-string transactionId must be rejected"
    );

    check(
        wrongType.code === "TRANSACTION_IDENTITY_INVALID",
        "non-string transactionId must fail with TRANSACTION_IDENTITY_INVALID"
    );

    // Empty-string destination is not a usable destination.
    expectThrow(
        () => normalizeIncomingTransferRecord(providerRecord({ destinationAddress: "   " }), {
            network: FIXTURE_NETWORK,
            providerId: FIXTURE_PROVIDER_ID
        }),
        "TransactionRecordIncompleteError",
        "blank destination address must be rejected"
    );

    // Unsupported direction.
    const direction = expectThrow(
        () => normalizeIncomingTransferRecord(providerRecord({ direction: "outgoing" }), {
            network: FIXTURE_NETWORK,
            providerId: FIXTURE_PROVIDER_ID
        }),
        "TransactionRecordRejectedError",
        "outgoing direction must be rejected"
    );

    check(
        direction.details.reason === TRANSFER_REJECTION_REASON.DIRECTION_UNSUPPORTED,
        "outgoing direction must report DIRECTION_UNSUPPORTED"
    );

    // Aborted transactions are contradictory as incoming transfers.
    const aborted = expectThrow(
        () => normalizeIncomingTransferRecord(providerRecord({ aborted: true }), {
            network: FIXTURE_NETWORK,
            providerId: FIXTURE_PROVIDER_ID
        }),
        "TransactionRecordRejectedError",
        "aborted transaction must be rejected"
    );

    check(
        aborted.details.reason === TRANSFER_REJECTION_REASON.RECORD_CONTRADICTORY,
        "aborted transaction must report RECORD_CONTRADICTORY"
    );

    console.log("[3/11] network + destination validation: PASS");

}

// ---------------------------------------------------------------------------
// Group 4 — transaction identity rules
// ---------------------------------------------------------------------------

{

    // Deterministic: same identity inputs -> same identifier.
    const identityA = deriveIncomingTransactionId({
        network: FIXTURE_NETWORK,
        providerId: FIXTURE_PROVIDER_ID,
        accountId: FIXTURE_ACCOUNT_ID,
        transactionId: FIXTURE_TRANSACTION_ID
    });

    const identityB = deriveIncomingTransactionId({
        network: FIXTURE_NETWORK,
        providerId: FIXTURE_PROVIDER_ID,
        accountId: FIXTURE_ACCOUNT_ID,
        transactionId: FIXTURE_TRANSACTION_ID
    });

    check(identityA === identityB, "transaction identity must be deterministic");

    // Scoped to the network: the same provider tx on another network differs.
    check(
        identityA !== deriveIncomingTransactionId({
            network: "mainnet",
            providerId: FIXTURE_PROVIDER_ID,
            accountId: FIXTURE_ACCOUNT_ID,
            transactionId: FIXTURE_TRANSACTION_ID
        }),
        "identity must be scoped to the network"
    );

    // Scoped to provider / account / transaction identity.
    check(
        identityA !== deriveIncomingTransactionId({
            network: FIXTURE_NETWORK,
            providerId: "other-provider",
            accountId: FIXTURE_ACCOUNT_ID,
            transactionId: FIXTURE_TRANSACTION_ID
        }),
        "identity must be scoped to the provider"
    );

    check(
        identityA !== deriveIncomingTransactionId({
            network: FIXTURE_NETWORK,
            providerId: FIXTURE_PROVIDER_ID,
            accountId: "acct-other",
            transactionId: FIXTURE_TRANSACTION_ID
        }),
        "identity must be scoped to the account"
    );

    check(
        identityA !== deriveIncomingTransactionId({
            network: FIXTURE_NETWORK,
            providerId: FIXTURE_PROVIDER_ID,
            accountId: FIXTURE_ACCOUNT_ID,
            transactionId: "synthetic-tx-0002"
        }),
        "identity must be scoped to the transaction"
    );

    // Amount, destination, sender and time are NEVER identity inputs.
    const transferBase = normalizeIncomingTransferRecord(providerRecord(), {
        network: FIXTURE_NETWORK,
        providerId: FIXTURE_PROVIDER_ID
    });

    const transferChangedPayload = normalizeIncomingTransferRecord(providerRecord({
        amountAtomic: "999999999",
        destinationAddress: FIXTURE_OTHER_WALLET,
        sourceAddress: FIXTURE_OTHER_SENDER,
        transactionTime: 1_700_000_999_000,
        comment: "DIFFERENT-REF"
    }), {
        network: FIXTURE_NETWORK,
        providerId: FIXTURE_PROVIDER_ID
    });

    check(
        transferBase.transactionId === transferChangedPayload.transactionId
            && transferBase.transactionId === identityA,
        "identity must not depend on amount, destination, sender, time or reference"
    );

    // Missing provider identity cannot produce an identifier.
    for (const field of ["accountId", "transactionId", "network"]) {

        expectThrow(
            () => deriveIncomingTransactionId({
                network: FIXTURE_NETWORK,
                providerId: FIXTURE_PROVIDER_ID,
                accountId: FIXTURE_ACCOUNT_ID,
                transactionId: FIXTURE_TRANSACTION_ID,
                [field]: undefined
            }),
            "TransactionIdentityError",
            `derive must reject missing ${field}`
        );

    }

    // Blank provider identity cannot produce an identifier.
    expectThrow(
        () => deriveIncomingTransactionId({
            network: FIXTURE_NETWORK,
            providerId: FIXTURE_PROVIDER_ID,
            accountId: "   ",
            transactionId: FIXTURE_TRANSACTION_ID
        }),
        "TransactionIdentityError",
        "derive must reject a blank accountId"
    );

    // Forged (non-derived) identifiers are rejected by the model.
    const forged = expectThrow(
        () => new IncomingTransfer({
            network: FIXTURE_NETWORK,
            transactionId: "not-a-derived-id",
            providerTransactionIdentity: {
                providerId: FIXTURE_PROVIDER_ID,
                accountId: FIXTURE_ACCOUNT_ID,
                transactionId: FIXTURE_TRANSACTION_ID
            },
            destinationWalletAddress: FIXTURE_DESTINATION,
            senderAddress: FIXTURE_SENDER,
            amountAtomic: 1000000000,
            asset: FIXTURE_ASSET,
            transactionTime: FIXTURE_TRANSACTION_TIME,
            paymentReference: null,
            providerConfirmed: null
        }),
        "TransactionIdentityError",
        "model must reject a non-derived transaction id"
    );

    check(
        forged.code === "TRANSACTION_IDENTITY_INVALID",
        "forged id must fail with TRANSACTION_IDENTITY_INVALID"
    );

    // Explicit contract declaration exists (no invented endpoint schema).
    check(
        INCOMING_TRANSFER_PROVIDER_CONTRACT.readonly === true
            && INCOMING_TRANSFER_PROVIDER_CONTRACT.operation === "listIncomingTransactions"
            && INCOMING_TRANSFER_PROVIDER_CONTRACT.requiredRecordFields.length > 0
            && INCOMING_TRANSFER_PROVIDER_CONTRACT.forbiddenOperations.length > 0,
        "the declared provider contract must be explicit and read-only"
    );

    console.log("[4/11] transaction identity: PASS");

}

// ---------------------------------------------------------------------------
// Group 5 — missing or duplicate payment reference
// ---------------------------------------------------------------------------

{

    // Missing reference is a legitimate observation (no comment), never guessed.
    const withoutReference = normalizeIncomingTransferRecord(
        providerRecord({ comment: undefined }),
        { network: FIXTURE_NETWORK, providerId: FIXTURE_PROVIDER_ID }
    );

    check(
        withoutReference.paymentReference === null,
        "absent comment must normalize to a null payment reference"
    );

    // ...but it can never match an intent that configures one.
    const missingMatch = matchIncomingTransferToIntent(withoutReference, buildIntent());

    check(
        missingMatch.matched === false
            && missingMatch.reason === TRANSFER_MATCH_REASON.PAYMENT_REFERENCE_MISSING,
        "missing payment reference must never be matched by guessing"
    );

    // A transfer carrying a different reference never matches either.
    const wrongReference = normalizeIncomingTransferRecord(
        providerRecord({ comment: "SOMEONE-ELSE-REF" }),
        { network: FIXTURE_NETWORK, providerId: FIXTURE_PROVIDER_ID }
    );

    const wrongMatch = matchIncomingTransferToIntent(wrongReference, buildIntent());

    check(
        wrongMatch.matched === false
            && wrongMatch.reason === TRANSFER_MATCH_REASON.PAYMENT_REFERENCE_MISMATCH,
        "mismatched payment reference must never match"
    );

    // Duplicate reference across two distinct transaction identities in one
    // batch is rejected (never silently resolved).
    const duplicateAdapter = buildAdapter({

        records: [

            providerRecord(),
            providerRecord({ transactionId: "synthetic-tx-0002" })

        ]

    });

    const collision = expectThrow(
        () => duplicateAdapter.observeIncomingTransactions(),
        "PaymentReferenceCollisionError",
        "duplicate payment reference must be rejected"
    );

    check(
        collision.details.paymentReference === FIXTURE_PAYMENT_REFERENCE,
        "collision must name the duplicated payment reference"
    );

    check(
        duplicateAdapter.observedTransactionCount === 0,
        "a rejected duplicate observation must not enter the ledger"
    );

    // Duplicate reference across two separate observations is also rejected:
    // a NEW transaction identity claiming an already-observed reference.
    const stagedAdapter = buildAdapter({

        providerClient: scriptedProviderClient([

            [providerRecord({ transactionId: "synthetic-tx-0001" })],
            [providerRecord({ transactionId: "synthetic-tx-0002" })]

        ])

    });

    stagedAdapter.observeIncomingTransactions();

    const lateDuplicate = expectThrow(
        () => stagedAdapter.observeIncomingTransactions(),
        "PaymentReferenceCollisionError",
        "late duplicate reference must be rejected"
    );

    check(
        lateDuplicate.details.transactionIds.length === 2,
        "late duplicate must report both conflicting transaction identities"
    );

    check(
        stagedAdapter.observedTransactionCount === 1,
        "a rejected late duplicate must not enter the ledger"
    );

    // A custom (injected) reference extractor is honoured verbatim.
    const customExtractAdapter = buildAdapter({
        records: [providerRecord({ comment: undefined, memo: "MEMO-REF-7" })],
        paymentReferenceExtractor: (record) => (
            typeof record.memo === "string" && record.memo.trim() !== ""
                ? record.memo.trim()
                : null
        )
    });

    const customObservation = customExtractAdapter.observeIncomingTransactions();

    check(
        customObservation.observed[0].paymentReference === "MEMO-REF-7",
        "injected payment reference extractor must be used"
    );

    console.log("[5/11] payment reference rules: PASS");

}

// ---------------------------------------------------------------------------
// Group 6 — correct unique match against a payment intent
// ---------------------------------------------------------------------------

{

    const adapter = buildAdapter();

    const transfer = adapter.normalizeProviderRecord(providerRecord());

    const intent = buildIntent();

    const result = matchIncomingTransferToIntent(transfer, intent);

    check(result.matched === true, "a fully agreeing transfer must match the intent");
    check(result.reason === null, "a match must have no rejection reason");
    check(result.mismatches.length === 0, "a match must have no mismatches");
    check(result.transactionId === transfer.transactionId, "match must report the derived transaction id");
    check(result.paymentReference === FIXTURE_PAYMENT_REFERENCE, "match must report the intent payment reference");

    // Unique resolution against exactly one intent.
    const resolved = resolveIncomingTransferMatch(transfer, [intent]);

    check(resolved.matched === true, "unique resolution must match");

    // The observation path can normalize, and the matcher stays pure.
    const observation = adapter.observeIncomingTransactions();

    check(observation.observed.length === 1, "one synthetic transaction must be observed");

    // Matching against several intents where only one agrees.
    const otherIntent = buildIntent({
        paymentReference: "SYNTHETIC-REF-0002",
        playerId: "player-synthetic-002",
        amountAtomic: 2000000000,
        expectedSender: FIXTURE_OTHER_SENDER
    });

    const resolvedAmongMany = resolveIncomingTransferMatch(transfer, [otherIntent, intent]);

    check(resolvedAmongMany.matched === true, "exactly one agreeing intent must resolve");
    check(resolvedAmongMany.paymentReference === FIXTURE_PAYMENT_REFERENCE, "the correct intent must resolve");

    // No intent agrees.
    const resolvedNone = resolveIncomingTransferMatch(transfer, [otherIntent]);

    check(
        resolvedNone.matched === false
            && resolvedNone.reason === TRANSFER_MATCH_REASON.NO_INTENT_MATCH,
        "zero agreeing intents must resolve to no match"
    );

    // When only the intent supplies a wallet id, the address match stands.
    const transferWithoutWalletId = normalizeIncomingTransferRecord(
        providerRecord({ destinationWalletId: undefined }),
        { network: FIXTURE_NETWORK, providerId: FIXTURE_PROVIDER_ID }
    );

    check(
        matchIncomingTransferToIntent(transferWithoutWalletId, buildIntent()).matched === true,
        "wallet id must be compared only when both sides supply one"
    );

    // An already-matched intent with the same transaction id is idempotent.
    const matchedIntent = buildIntent({
        state: "MATCHED",
        transactionId: transfer.transactionId
    });

    check(
        matchIncomingTransferToIntent(transfer, matchedIntent).matched === true,
        "an intent already matched to this transaction must match idempotently"
    );

    // Terminal and already-matched intents can never match another transfer.
    const settledIntent = buildIntent({
        state: "SETTLED",
        transactionId: "ttx_" + "0".repeat(64)
    });

    const terminalResult = matchIncomingTransferToIntent(transfer, settledIntent);

    check(
        terminalResult.matched === false
            && terminalResult.reason === TRANSFER_MATCH_REASON.INTENT_NOT_MATCHABLE,
        "a terminal intent must never match"
    );

    const matchedOtherIntent = buildIntent({
        state: "MATCHED",
        transactionId: "ttx_" + "1".repeat(64)
    });

    const alreadyMatched = matchIncomingTransferToIntent(transfer, matchedOtherIntent);

    check(
        alreadyMatched.matched === false
            && alreadyMatched.reason === TRANSFER_MATCH_REASON.INTENT_ALREADY_MATCHED,
        "an intent matched to a different transaction must never match"
    );

    console.log("[6/11] unique match: PASS");

}

// ---------------------------------------------------------------------------
// Group 7 — wrong sender, destination, network, asset, amount
// ---------------------------------------------------------------------------

{

    const transfer = normalizeIncomingTransferRecord(providerRecord(), {
        network: FIXTURE_NETWORK,
        providerId: FIXTURE_PROVIDER_ID
    });

    const cases = [

        [
            "wrong sender",
            buildIntent({ expectedSender: FIXTURE_OTHER_SENDER }),
            TRANSFER_MATCH_REASON.SENDER_MISMATCH
        ],
        [
            "wrong destination",
            buildIntent({ destinationWalletAddress: FIXTURE_OTHER_WALLET }),
            TRANSFER_MATCH_REASON.DESTINATION_ADDRESS_MISMATCH
        ],
        [
            "wrong network",
            buildIntent({ network: "mainnet" }),
            TRANSFER_MATCH_REASON.NETWORK_MISMATCH
        ],
        [
            "wrong asset",
            buildIntent({ asset: "USDT" }),
            TRANSFER_MATCH_REASON.ASSET_MISMATCH
        ],
        [
            "underpayment",
            buildIntent({ amountAtomic: 999999999 }),
            TRANSFER_MATCH_REASON.AMOUNT_MISMATCH
        ],
        [
            "overpayment",
            buildIntent({ amountAtomic: 1000000001 }),
            TRANSFER_MATCH_REASON.AMOUNT_MISMATCH
        ],
        [
            "wrong payment reference",
            buildIntent({ paymentReference: "SYNTHETIC-REF-9999" }),
            TRANSFER_MATCH_REASON.PAYMENT_REFERENCE_MISMATCH
        ]

    ];

    for (const [label, intent, expectedReason] of cases) {

        const result = matchIncomingTransferToIntent(transfer, intent);

        check(result.matched === false, `${label} must not match`);
        check(
            result.reason === expectedReason,
            `${label} must report ${expectedReason} (got ${result.reason})`
        );

    }

    // Wrong destination wallet id (both sides present) must not match.
    const walletIdResult = matchIncomingTransferToIntent(
        transfer,
        buildIntent({ destinationWalletId: "room-wallet-002" })
    );

    check(
        walletIdResult.matched === false
            && walletIdResult.reason === TRANSFER_MATCH_REASON.DESTINATION_WALLET_ID_MISMATCH,
        "wrong destination wallet id must not match"
    );

    // An exact-amount mismatch is never a partial credit.
    check(
        matchIncomingTransferToIntent(transfer, buildIntent({ amountAtomic: 500000000 }))
            .reason === TRANSFER_MATCH_REASON.AMOUNT_MISMATCH,
        "a partial amount must never match"
    );

    // Every mismatch reason is collected, not just the first.
    const manyMismatches = matchIncomingTransferToIntent(
        transfer,
        buildIntent({
            expectedSender: FIXTURE_OTHER_SENDER,
            asset: "USDT",
            amountAtomic: 1
        })
    );

    check(
        manyMismatches.mismatches.length === 3,
        "all mismatching fields must be reported"
    );

    console.log("[7/11] negative match cases: PASS");

}

// ---------------------------------------------------------------------------
// Group 8 — a transaction that would match multiple intents
// ---------------------------------------------------------------------------

{

    // Two intents in different rooms configured with the SAME payment
    // reference, sender, destination, amount and asset — the transfer agrees
    // with both, so attribution is ambiguous and must be rejected.
    const transfer = normalizeIncomingTransferRecord(providerRecord(), {
        network: FIXTURE_NETWORK,
        providerId: FIXTURE_PROVIDER_ID
    });

    const intentA = buildIntent({
        roomId: "room-synthetic-A",
        playerId: "player-synthetic-A"
    });

    const intentB = buildIntent({
        roomId: "room-synthetic-B",
        playerId: "player-synthetic-B"
    });

    // Each pair individually agrees.
    check(
        matchIncomingTransferToIntent(transfer, intentA).matched === true
            && matchIncomingTransferToIntent(transfer, intentB).matched === true,
        "both ambiguous intents individually agree with the transfer"
    );

    const ambiguous = expectThrow(
        () => resolveIncomingTransferMatch(transfer, [intentA, intentB]),
        "AmbiguousTransferMatchError",
        "a multi-intent match must be rejected as ambiguous"
    );

    check(
        ambiguous.code === "TRANSFER_MATCH_AMBIGUOUS",
        "ambiguity must fail with TRANSFER_MATCH_AMBIGUOUS"
    );

    check(
        Array.isArray(ambiguous.details.candidateReferences)
            && ambiguous.details.candidateReferences.length === 2,
        "ambiguity must list both candidate payment references"
    );

    // A reference that distinguishes the intents resolves the ambiguity.
    const intentBWithOwnReference = buildIntent({
        roomId: "room-synthetic-B",
        playerId: "player-synthetic-B",
        paymentReference: "SYNTHETIC-REF-0002"
    });

    const unambiguous = resolveIncomingTransferMatch(transfer, [intentA, intentBWithOwnReference]);

    check(
        unambiguous.matched === true
            && unambiguous.paymentReference === FIXTURE_PAYMENT_REFERENCE,
        "a distinguishing payment reference must resolve the ambiguity exactly"
    );

    // The adapter-level resolution is equally strict.
    const adapter = buildAdapter();

    expectThrow(
        () => adapter.evaluateMatches([transfer], [intentA, intentB]),
        "AmbiguousTransferMatchError",
        "adapter.evaluateMatches must also reject ambiguity"
    );

    console.log("[8/11] ambiguous multi-intent match: PASS");

}

// ---------------------------------------------------------------------------
// Group 9 — replay of the same provider transaction identity
// ---------------------------------------------------------------------------

{

    const adapter = buildAdapter({ records: [providerRecord()] });

    const first = adapter.observeIncomingTransactions();

    check(first.observed.length === 1, "first observation must register the transaction");
    check(first.replays.length === 0, "first observation must have no replays");
    check(adapter.observedTransactionCount === 1, "ledger must hold one transaction");

    // Exact replay of the same provider identity is idempotent.
    const second = adapter.observeIncomingTransactions();

    check(second.observed.length === 0, "an exact replay must not be re-observed");
    check(second.replays.length === 1, "an exact replay must be reported as a replay");
    check(adapter.observedTransactionCount === 1, "replay must not duplicate the ledger entry");

    // The replayed observation carries the same derived identity.
    check(
        second.replays[0].transactionId === first.observed[0].transactionId,
        "replay must carry the same derived transaction identity"
    );

    // Same provider identity with different content is a contradiction: the
    // second provider read mutates the amount of the same transaction.
    const contradictionAdapter = buildAdapter({

        providerClient: scriptedProviderClient([

            [providerRecord({ transactionId: "synthetic-tx-0001" })],
            [providerRecord({ transactionId: "synthetic-tx-0001", amountAtomic: "1000000001" })]

        ])

    });

    contradictionAdapter.observeIncomingTransactions();

    const conflict = expectThrow(
        () => contradictionAdapter.observeIncomingTransactions(),
        "ObservationConflictError",
        "a contradictory replay must be rejected"
    );

    check(
        conflict.code === "TRANSACTION_OBSERVATION_CONFLICT",
        "contradictory replay must fail with TRANSACTION_OBSERVATION_CONFLICT"
    );

    check(
        contradictionAdapter.observedTransactionCount === 1,
        "a contradictory replay must not enter the ledger"
    );

    // Distinguished by payment reference instead of amount is equally
    // contradictory.
    const referenceConflictAdapter = buildAdapter({

        providerClient: scriptedProviderClient([

            [providerRecord({ transactionId: "synthetic-tx-0001" })],
            [providerRecord({ transactionId: "synthetic-tx-0001", comment: "SYNTHETIC-REF-9999" })]

        ])

    });

    referenceConflictAdapter.observeIncomingTransactions();

    expectThrow(
        () => referenceConflictAdapter.observeIncomingTransactions(),
        "ObservationConflictError",
        "same identity with a different reference must be rejected"
    );

    // Distinct transactions are separate observations.
    const distinctAdapter = buildAdapter({

        records: [

            providerRecord({ transactionId: "synthetic-tx-0001" }),
            providerRecord({ transactionId: "synthetic-tx-0002", comment: "SYNTHETIC-REF-0002" })

        ]

    });

    const distinct = distinctAdapter.observeIncomingTransactions();

    check(distinct.observed.length === 2, "distinct provider transactions must be distinct observations");

    console.log("[9/11] replay + contradiction: PASS");

}

// ---------------------------------------------------------------------------
// Group 10 — provider error, malformed provider response, incomplete data
// ---------------------------------------------------------------------------

{

    // 10a. Provider that throws.
    const throwingAdapter = buildAdapter({
        providerClient: mockProviderClient([], { failWith: new Error("provider unavailable") })
    });

    const providerFailure = expectThrow(
        () => throwingAdapter.observeIncomingTransactions(),
        "ProviderRequestError",
        "a failing provider must be wrapped"
    );

    check(
        providerFailure.code === "PROVIDER_REQUEST_FAILED"
            && providerFailure.details.providerError === "Error",
        "provider failure must fail with PROVIDER_REQUEST_FAILED"
    );

    check(
        throwingAdapter.observedTransactionCount === 0,
        "a failed provider read must not observe anything"
    );

    // 10b. Malformed provider responses.
    for (const [label, response] of [

        ["object response", { transactions: [] }],
        ["string response", "not-an-array"],
        ["null response", null],
        ["undefined response", undefined],
        ["promise response", Promise.resolve([providerRecord()])]

    ]) {

        const malformedAdapter = buildAdapter({
            providerClient: mockProviderClient([], { response })
        });

        expectThrow(
            () => malformedAdapter.observeIncomingTransactions(),
            "ProviderResponseError",
            `malformed provider response must be rejected: ${label}`
        );

        check(
            malformedAdapter.observedTransactionCount === 0,
            `${label} must not observe anything`
        );

    }

    // 10c. Incomplete transaction data inside an otherwise valid response.
    const incompleteAdapter = buildAdapter({

        records: [

            providerRecord({ transactionId: "synthetic-tx-0001" }),
            providerRecord({ transactionId: "synthetic-tx-0002", sourceAddress: undefined })

        ]

    });

    const incomplete = expectThrow(
        () => incompleteAdapter.observeIncomingTransactions(),
        "TransactionRecordIncompleteError",
        "an incomplete record must abort the whole observation"
    );

    check(
        incomplete.details.missingFields.includes("sourceAddress"),
        "the incomplete record must name the missing field"
    );

    check(
        incompleteAdapter.observedTransactionCount === 0,
        "a failed observation must not leave partial state in the ledger"
    );

    // 10d. Malformed records that are not objects.
    for (const [label, record] of [

        ["null record", null],
        ["string record", "transaction"],
        ["array record", [providerRecord()]]

    ]) {

        const malformedRecordAdapter = buildAdapter({ records: [record] });

        expectThrow(
            () => malformedRecordAdapter.observeIncomingTransactions(),
            "TransactionRecordIncompleteError",
            `malformed record must be rejected: ${label}`
        );

    }

    // 10e. Secret-bearing records are rejected outright (fail closed).
    for (const field of INCOMING_TRANSFER_PROVIDER_CONTRACT.forbiddenRecordFields) {

        const secretAdapter = buildAdapter({

            records: [providerRecord({ [field]: "SUPER-SECRET" })]

        });

        const secretRejection = expectThrow(
            () => secretAdapter.observeIncomingTransactions(),
            "SecretBearingRecordError",
            `a record carrying ${field} must be rejected`
        );

        check(
            secretRejection.details.field === field,
            `the rejection must name the forbidden field: ${field}`
        );

    }

    // 10f. The provider is called exactly once per observation with the
    // caller's options, and nothing else is ever requested from it.
    const countingClient = mockProviderClient([providerRecord()]);
    const countingAdapter = buildAdapter({ providerClient: countingClient });

    countingAdapter.observeIncomingTransactions({ accountId: FIXTURE_ACCOUNT_ID, limit: 10 });

    check(countingClient.calls.length === 1, "the provider must be read exactly once per observation");
    check(
        countingClient.calls[0].listOptions.accountId === FIXTURE_ACCOUNT_ID
            && countingClient.calls[0].listOptions.limit === 10,
        "provider options must be forwarded unchanged"
    );

    console.log("[10/11] provider failures + malformed data: PASS");

}

// ---------------------------------------------------------------------------
// Group 11 — the adapter cannot send, broadcast, or confirm anything
// ---------------------------------------------------------------------------

{

    // 11a. No forbidden operation exists on the adapter prototype.
    assertNoOperations(
        IncomingTransferAdapter.prototype,
        INCOMING_TRANSFER_ADAPTER_FORBIDDEN_OPERATIONS
    );

    checksPassed += 1;

    check(
        Object.getOwnPropertyNames(IncomingTransferAdapter.prototype)
            .every((name) => !INCOMING_TRANSFER_ADAPTER_FORBIDDEN_OPERATIONS.includes(name)),
        "the adapter prototype must expose no write/confirmation operation"
    );

    // 11b. No forbidden operation exists on an adapter instance.
    const adapter = buildAdapter();

    for (const operation of INCOMING_TRANSFER_ADAPTER_FORBIDDEN_OPERATIONS) {

        check(
            typeof adapter[operation] !== "function",
            `adapter instance must not expose ${operation}`
        );

    }

    // 11c. The declared capability list contains no write/confirm capability.
    for (const capability of INCOMING_TRANSFER_ADAPTER_CAPABILITIES) {

        check(
            !/send|broadcast|sign|deploy|confirm|settle|credit|refund|transfer|burn/i.test(capability),
            `capability "${capability}" must not imply a write or confirmation`
        );

    }

    // 11d. Confirmation is structurally impossible.
    check(adapter.canConfirmPayments() === false, "the adapter must report that it cannot confirm payments");
    check(adapter.confirmationDisposition === PAYMENT_CONFIRMATION_DISPOSITION.OBSERVATION_ONLY, "the adapter disposition must be observation-only");

    const observation = adapter.observeIncomingTransactions();

    check(
        observation.disposition === PAYMENT_CONFIRMATION_DISPOSITION.OBSERVATION_ONLY,
        "observation results must be marked observation-only"
    );

    check(
        isPaymentConfirmationDisposition(observation.disposition) === false,
        "no observation disposition can ever be a payment confirmation"
    );

    // An unconfirmed provider transaction is observed, but it is still only
    // an observation — never a payment confirmation.
    const unconfirmedAdapter = buildAdapter({

        records: [providerRecord({ confirmed: false })]

    });

    const unconfirmedObservation = unconfirmedAdapter.observeIncomingTransactions();

    check(
        unconfirmedObservation.observed[0].providerConfirmed === false
            && unconfirmedObservation.disposition === PAYMENT_CONFIRMATION_DISPOSITION.OBSERVATION_ONLY
            && isPaymentConfirmationDisposition(unconfirmedObservation.disposition) === false,
        "an unconfirmed provider transaction must remain an observation only"
    );

    // 11e. Observation and evaluation never mutate a payment intent.
    const intent = buildIntent();

    const before = intent.toRecord();

    const transfer = adapter.normalizeProviderRecord(providerRecord());

    const match = adapter.evaluateMatch(transfer, [intent]);

    check(match.matched === true, "the evaluation must match (evaluation only)");

    check(
        intent.state === "PENDING" && intent.transactionId === null,
        "evaluation must not match/credit the intent"
    );

    check(
        intent.toRecord().updatedAt === null && before.updatedAt === null,
        "evaluation must not touch intent timestamps"
    );

    check(Object.isFrozen(intent), "the Phase 1 intent remains frozen and untouched");

    check(
        JSON.stringify(before) === JSON.stringify(intent.toRecord()),
        "the intent record must be byte-identical after evaluation"
    );

    // 11f. No network access happens anywhere in the observation+evaluation
    // cycle: any fetch attempt throws before it can leave the process.
    const originalFetch = globalThis.fetch;

    globalThis.fetch = () => {

        throw new Error("network access attempted by the adapter");

    };

    try {

        const guarded = buildAdapter({ records: [providerRecord()] });

        guarded.observeIncomingTransactions();

        guarded.evaluateMatch(guarded.listObservedTransfers()[0], [intent]);

        check(true, "observe + evaluate must not require network access");

    } finally {

        globalThis.fetch = originalFetch;

    }

    // 11g. The read-only provider boundary itself refuses write-capable clients.
    const writeCapableClient = {

        listIncomingTransactions: () => [],
        sendTransaction: () => {

            throw new Error("must never be called");

        }

    };

    const boundaryRejection = expectThrow(
        () => buildAdapter({ providerClient: writeCapableClient }),
        "ProviderContractError",
        "the adapter must refuse a write-capable provider client"
    );

    check(
        boundaryRejection.code === "PROVIDER_CONTRACT_VIOLATION"
            && boundaryRejection.details.forbiddenOperation === "sendTransaction",
        "the refusal must name the forbidden write operation"
    );

    // A client without the declared read operation is refused, too.
    expectThrow(
        () => buildAdapter({ providerClient: {} }),
        "ProviderContractError",
        "a client without listIncomingTransactions must be refused"
    );

    expectThrow(
        () => buildAdapter({ providerClient: null }),
        "ProviderContractError",
        "a missing provider client must be refused"
    );

    // The synthetic mock passes the same boundary check.
    assertReadOnlyProviderClient(mockProviderClient());

    checksPassed += 1;

    // The provider interface declaration cannot be instantiated directly.
    expectThrow(
        () => new IncomingTransferProviderClient(),
        "PaymentValidationError",
        "the provider interface declaration must not be instantiable"
    );

    console.log("[11/12] no send/broadcast/confirm capability: PASS");

}

// ---------------------------------------------------------------------------
// Group 12 — canonical TON address identity matching (raw ↔ friendly)
// ---------------------------------------------------------------------------

{

    // 12a. A provider record carrying RAW addresses (the Toncenter v3 live
    // response form) must match an intent that stores the equivalent
    // user-friendly wallet and sender addresses (the Phase 1 catalog form).
    const rawRecord = providerRecord({
        sourceAddress: FIXTURE_SENDER_RAW,
        destinationAddress: FIXTURE_DESTINATION_RAW
    });

    const rawTransfer = normalizeIncomingTransferRecord(rawRecord, {
        network: FIXTURE_NETWORK,
        providerId: FIXTURE_PROVIDER_ID
    });

    check(
        rawTransfer.senderAddress === FIXTURE_SENDER_RAW
            && rawTransfer.destinationWalletAddress === FIXTURE_DESTINATION_RAW,
        "the raw provider address must be preserved verbatim (no rewriting)"
    );

    check(
        matchIncomingTransferToIntent(rawTransfer, buildIntent()).matched === true,
        "a raw provider address must match the friendly wallet-catalog address"
    );

    // 12b. The other direction: friendly provider addresses against a raw
    // intent representation is the same account identity.
    const friendlyRecord = providerRecord({
        sourceAddress: FIXTURE_SENDER,
        destinationAddress: FIXTURE_DESTINATION
    });

    const friendlyTransfer = normalizeIncomingTransferRecord(friendlyRecord, {
        network: FIXTURE_NETWORK,
        providerId: FIXTURE_PROVIDER_ID
    });

    const rawIntent = buildIntent({
        expectedSender: FIXTURE_SENDER_RAW,
        destinationWalletAddress: FIXTURE_DESTINATION_RAW
    });

    check(
        matchIncomingTransferToIntent(friendlyTransfer, rawIntent).matched === true,
        "a friendly provider address must match a raw wallet-catalog address"
    );

    check(
        matchIncomingTransferToIntent(friendlyTransfer, buildIntent()).matched === true,
        "identical friendly representations must still match"
    );

    // 12c. Non-bounceable (UQ) representations denote the same account.
    const uqRecord = providerRecord({
        sourceAddress: FIXTURE_SENDER_UQ,
        destinationAddress: FIXTURE_DESTINATION_UQ
    });

    const uqTransfer = normalizeIncomingTransferRecord(uqRecord, {
        network: FIXTURE_NETWORK,
        providerId: FIXTURE_PROVIDER_ID
    });

    check(
        matchIncomingTransferToIntent(uqTransfer, buildIntent()).matched === true,
        "a UQ (non-bounceable) address must match the EQ wallet-catalog address"
    );

    // 12d. Standard base64 (rather than base64url) encodings are handled.
    const standardRecord = providerRecord({
        sourceAddress: FIXTURE_SENDER_UQ_STANDARD,
        destinationAddress: FIXTURE_DESTINATION_UQ_STANDARD
    });

    const standardTransfer = normalizeIncomingTransferRecord(standardRecord, {
        network: FIXTURE_NETWORK,
        providerId: FIXTURE_PROVIDER_ID
    });

    check(
        matchIncomingTransferToIntent(standardTransfer, buildIntent()).matched === true,
        "standard base64 and base64url encodings must denote one account"
    );

    // 12e. A different account hash never matches (raw, friendly and mixed).
    const otherHashCases = [

        [
            "destination only (raw)",
            { destinationAddress: FIXTURE_OTHER_WALLET },
            [
                TRANSFER_MATCH_REASON.DESTINATION_ADDRESS_MISMATCH
            ]
        ],
        [
            "destination only (friendly wallet)",
            { destinationAddress: FIXTURE_OTHER_WALLET },
            [
                TRANSFER_MATCH_REASON.DESTINATION_ADDRESS_MISMATCH
            ]
        ],
        [
            "sender only (raw)",
            { sourceAddress: FIXTURE_OTHER_SENDER },
            [
                TRANSFER_MATCH_REASON.SENDER_MISMATCH
            ]
        ],
        [
            "both sides",
            {
                destinationAddress: FIXTURE_OTHER_WALLET,
                sourceAddress: FIXTURE_OTHER_SENDER
            },
            [
                TRANSFER_MATCH_REASON.DESTINATION_ADDRESS_MISMATCH,
                TRANSFER_MATCH_REASON.SENDER_MISMATCH
            ]
        ]

    ];

    for (const [label, override, expectedMismatches] of otherHashCases) {

        const otherTransfer = normalizeIncomingTransferRecord(
            providerRecord(override),
            {
                network: FIXTURE_NETWORK,
                providerId: FIXTURE_PROVIDER_ID
            }
        );

        const result = matchIncomingTransferToIntent(otherTransfer, buildIntent());

        check(
            result.matched === false
                && result.reason === expectedMismatches[0]
                && expectedMismatches.every((reason) => result.mismatches.includes(reason))
                && result.mismatches.length === expectedMismatches.length,
            `a different account hash must never match (${label})`
        );

    }

    // 12f. A different workchain never matches, even with an identical hash.
    const otherWorkchainTransfer = normalizeIncomingTransferRecord(providerRecord({
        sourceAddress: FIXTURE_SENDER,
        destinationAddress: FIXTURE_DESTINATION_OTHER_WORKCHAIN
    }), {
        network: FIXTURE_NETWORK,
        providerId: FIXTURE_PROVIDER_ID
    });

    const workchainResult = matchIncomingTransferToIntent(
        otherWorkchainTransfer,
        buildIntent()
    );

    check(
        workchainResult.matched === false
            && workchainResult.reason
                === TRANSFER_MATCH_REASON.DESTINATION_ADDRESS_MISMATCH,
        "a different workchain must never match"
    );

    // 12g. Malformed addresses are rejected with an explicit reason — no
    // approximate matching, no prefix tricks, no silent repair.
    const invalidDestinationTransfer = normalizeIncomingTransferRecord(providerRecord({
        destinationAddress: FIXTURE_BAD_CHECKSUM_ADDRESS
    }), {
        network: FIXTURE_NETWORK,
        providerId: FIXTURE_PROVIDER_ID
    });

    const invalidDestinationResult = matchIncomingTransferToIntent(
        invalidDestinationTransfer,
        buildIntent()
    );

    check(
        invalidDestinationResult.matched === false
            && invalidDestinationResult.reason
                === TRANSFER_MATCH_REASON.DESTINATION_ADDRESS_INVALID,
        "a bad-checksum destination must be rejected as invalid"
    );

    const invalidSenderTransfer = normalizeIncomingTransferRecord(providerRecord({
        sourceAddress: FIXTURE_FABRICATED_ADDRESS
    }), {
        network: FIXTURE_NETWORK,
        providerId: FIXTURE_PROVIDER_ID
    });

    const invalidSenderResult = matchIncomingTransferToIntent(
        invalidSenderTransfer,
        buildIntent()
    );

    check(
        invalidSenderResult.matched === false
            && invalidSenderResult.reason
                === TRANSFER_MATCH_REASON.SENDER_ADDRESS_INVALID,
        "a fabricated EQ-prefixed sender must be rejected as invalid"
    );

    // A malformed INTENT address is equally rejected.
    const invalidIntentResult = matchIncomingTransferToIntent(
        normalizeIncomingTransferRecord(providerRecord(), {
            network: FIXTURE_NETWORK,
            providerId: FIXTURE_PROVIDER_ID
        }),
        buildIntent({ destinationWalletAddress: FIXTURE_FABRICATED_ADDRESS })
    );

    check(
        invalidIntentResult.matched === false
            && invalidIntentResult.reason
                === TRANSFER_MATCH_REASON.DESTINATION_ADDRESS_INVALID,
        "a malformed intent destination must be rejected as invalid"
    );

    const invalidIntentSenderResult = matchIncomingTransferToIntent(
        normalizeIncomingTransferRecord(providerRecord(), {
            network: FIXTURE_NETWORK,
            providerId: FIXTURE_PROVIDER_ID
        }),
        buildIntent({ expectedSender: FIXTURE_BAD_CHECKSUM_ADDRESS })
    );

    check(
        invalidIntentSenderResult.matched === false
            && invalidIntentSenderResult.reason
                === TRANSFER_MATCH_REASON.SENDER_ADDRESS_INVALID,
        "a malformed intent sender must be rejected as invalid"
    );

    // 12h. Address identity never relaxes the other match requirements: each
    // stays independent and strict while the address form changes.
    const independenceCases = [

        ["network", { network: "mainnet" }, TRANSFER_MATCH_REASON.NETWORK_MISMATCH],
        ["asset", { asset: "USDT" }, TRANSFER_MATCH_REASON.ASSET_MISMATCH],
        ["amount", { amountAtomic: 999999999 }, TRANSFER_MATCH_REASON.AMOUNT_MISMATCH],
        [
            "payment reference",
            { paymentReference: "SYNTHETIC-REF-9999" },
            TRANSFER_MATCH_REASON.PAYMENT_REFERENCE_MISMATCH
        ],
        [
            "destination wallet id",
            { destinationWalletId: "room-wallet-002" },
            TRANSFER_MATCH_REASON.DESTINATION_WALLET_ID_MISMATCH
        ]

    ];

    for (const [label, override, expectedReason] of independenceCases) {

        const result = matchIncomingTransferToIntent(rawTransfer, buildIntent(override));

        check(
            result.matched === false
                && result.mismatches.includes(expectedReason),
            `raw-matched address identity must not relax ${label} validation`
        );

    }

    // 12i. Ambiguous multi-intent matching still fails closed when the
    // addresses are expressed in different forms.
    const ambiguousRaw = normalizeIncomingTransferRecord(providerRecord({
        sourceAddress: FIXTURE_SENDER_RAW,
        destinationAddress: FIXTURE_DESTINATION_RAW
    }), {
        network: FIXTURE_NETWORK,
        providerId: FIXTURE_PROVIDER_ID
    });

    const friendlyIntentA = buildIntent({
        roomId: "room-synthetic-raw-A",
        playerId: "player-synthetic-raw-A"
    });

    const rawIntentB = buildIntent({
        roomId: "room-synthetic-raw-B",
        playerId: "player-synthetic-raw-B",
        expectedSender: FIXTURE_SENDER_RAW,
        destinationWalletAddress: FIXTURE_DESTINATION_RAW
    });

    check(
        matchIncomingTransferToIntent(ambiguousRaw, friendlyIntentA).matched === true
            && matchIncomingTransferToIntent(ambiguousRaw, rawIntentB).matched === true,
        "both address representations must individually agree with the transfer"
    );

    expectThrow(
        () => resolveIncomingTransferMatch(ambiguousRaw, [friendlyIntentA, rawIntentB]),
        "AmbiguousTransferMatchError",
        "multi-intent ambiguity must be rejected regardless of address form"
    );

    // 12j. Transaction identity is unaffected by address representation: the
    // same provider transaction expressed raw or friendly keeps one identity.
    check(
        rawTransfer.transactionId === friendlyTransfer.transactionId
            && rawTransfer.transactionId === uqTransfer.transactionId,
        "address representation must never change the transaction identity"
    );

    console.log("[12/13] canonical address identity matching: PASS");

}

// ---------------------------------------------------------------------------
// Group 13 — native TON payment reference codec (Phase 3C)
// ---------------------------------------------------------------------------

// 13a. Round-trip formatting and parsing of valid references.
{

    const validReferences = [

        "A",
        "Z9",
        "SYNTHETIC-REF-0001",
        "WW-PAY-ROOM1-0001",
        "room_1_player_2",
        "MixedCase-Ref_42",
        "R".repeat(PAYMENT_REFERENCE_MAX_LENGTH)

    ];

    for (const reference of validReferences) {

        const comment = formatPaymentReference(reference);

        check(
            comment === `${PAYMENT_REFERENCE_COMMENT_PREFIX}${reference}`,
            `the comment for ${reference} must be exactly WW1:<reference>`
        );

        check(
            extractPaymentReference(comment) === reference,
            `the reference extracted from WW1:${reference} must be identical`
        );

        check(
            isPaymentReferenceComment(comment) === true
                && isPaymentReference(reference) === true,
            `a well-formed comment and reference must be recognized: ${reference}`
        );

        // Phase 1 interop: the extracted value is a usable payment reference
        // for the actual PaymentIntent model, and the intent keeps it as its
        // identity. The codec never invents a second identity.
        const intent = buildIntent({ paymentReference: reference });

        check(
            intent.paymentReference === reference
                && intent.paymentReference === extractPaymentReference(comment),
            "the extracted reference must interoperate with the Phase 1 paymentReference"
        );

    }

    // Deterministic and injective: equal references produce equal comments,
    // distinct references produce distinct comments.
    check(
        formatPaymentReference(FIXTURE_PAYMENT_REFERENCE)
            === formatPaymentReference(FIXTURE_PAYMENT_REFERENCE)
            && formatPaymentReference(FIXTURE_PAYMENT_REFERENCE)
                !== formatPaymentReference("SYNTHETIC-REF-0002"),
        "formatting must be deterministic and distinct per reference"
    );

    // The envelope is fixed: no other prefix is a payment-reference comment.
    check(
        PAYMENT_REFERENCE_COMMENT_PREFIX === "WW1:"
            && isPaymentReferenceComment("WW2:SYNTHETIC-REF-0001") === false
            && isPaymentReferenceComment("WW10:SYNTHETIC-REF-0001") === false,
        "only the exact WW1: envelope is a payment reference comment"
    );

    console.log("[13a] payment reference codec round-trip: PASS");

}

// 13b. Rejection of empty, malformed, overlong, ambiguous and unsupported
//      references — extraction returns null and formatting refuses.
{

    const absentOrWrongType = [

        ["undefined", undefined],
        ["null", null],
        ["empty string", ""],
        ["blank string", "   "],
        ["number", 42],
        ["boolean", true],
        ["object", {}],
        ["array", []]

    ];

    for (const [label, comment] of absentOrWrongType) {

        check(
            extractPaymentReference(comment) === null,
            `${label} must never yield a payment reference`
        );

    }

    const rejectedComments = [

        ["no envelope", FIXTURE_PAYMENT_REFERENCE, PAYMENT_REFERENCE_REJECTION_REASON.COMMENT_PREFIX_MISMATCH],
        ["lowercase envelope", "ww1:SYNTHETIC-REF-0001", PAYMENT_REFERENCE_REJECTION_REASON.COMMENT_PREFIX_MISMATCH],
        ["mixed-case envelope", "Ww1:SYNTHETIC-REF-0001", PAYMENT_REFERENCE_REJECTION_REASON.COMMENT_PREFIX_MISMATCH],
        ["leading whitespace", " WW1:SYNTHETIC-REF-0001", PAYMENT_REFERENCE_REJECTION_REASON.COMMENT_PREFIX_MISMATCH],
        ["envelope only", "WW1:", PAYMENT_REFERENCE_REJECTION_REASON.REFERENCE_EMPTY],
        ["whitespace after the envelope", "WW1: SYNTHETIC-REF-0001", PAYMENT_REFERENCE_REJECTION_REASON.REFERENCE_MALFORMED],
        ["trailing whitespace", "WW1:SYNTHETIC-REF-0001 ", PAYMENT_REFERENCE_REJECTION_REASON.REFERENCE_MALFORMED],
        ["trailing newline", "WW1:SYNTHETIC-REF-0001\n", PAYMENT_REFERENCE_REJECTION_REASON.REFERENCE_MALFORMED],
        ["nested envelope", "WW1:WW1:SYNTHETIC-REF-0001", PAYMENT_REFERENCE_REJECTION_REASON.REFERENCE_AMBIGUOUS],
        ["separator inside the reference", "WW1:SYNTHETIC:REF-0001", PAYMENT_REFERENCE_REJECTION_REASON.REFERENCE_MALFORMED],
        ["whitespace inside the reference", "WW1:SYNTHETIC REF 0001", PAYMENT_REFERENCE_REJECTION_REASON.REFERENCE_MALFORMED],
        ["non-ASCII reference", "WW1:SYNTHETIC-RÉF-0001", PAYMENT_REFERENCE_REJECTION_REASON.REFERENCE_MALFORMED],
        ["zero-width character", "WW1:SYNTHETIC-REF-0001\u200b", PAYMENT_REFERENCE_REJECTION_REASON.REFERENCE_MALFORMED],
        ["overlong reference", `WW1:${"R".repeat(PAYMENT_REFERENCE_MAX_LENGTH + 1)}`, PAYMENT_REFERENCE_REJECTION_REASON.REFERENCE_OVERLONG],
        ["unsupported version", "WW2:SYNTHETIC-REF-0001", PAYMENT_REFERENCE_REJECTION_REASON.COMMENT_PREFIX_MISMATCH],
        ["unanchored envelope", "XWW1:SYNTHETIC-REF-0001", PAYMENT_REFERENCE_REJECTION_REASON.COMMENT_PREFIX_MISMATCH]

    ];

    for (const [label, comment, expectedReason] of rejectedComments) {

        const inspection = inspectPaymentReferenceComment(comment);

        check(
            extractPaymentReference(comment) === null
                && isPaymentReferenceComment(comment) === false,
            `${label} must never yield a payment reference`
        );

        check(
            inspection.valid === false
                && inspection.paymentReference === null
                && inspection.reason === expectedReason,
            `${label} must be rejected as ${expectedReason} (got ${inspection.reason})`
        );

    }

    // Formatting refuses everything extraction refuses, and never returns a
    // comment that could not be parsed back.
    const invalidReferences = [

        ["undefined", undefined],
        ["null", null],
        ["empty string", ""],
        ["blank string", "   "],
        ["whitespace padded", " REF-0001 "],
        ["whitespace inside", "SYNTHETIC REF 0001"],
        ["separator inside", "SYNTHETIC:REF"],
        ["non-ASCII", "SYNTHETIC-RÉF"],
        ["overlong", "R".repeat(PAYMENT_REFERENCE_MAX_LENGTH + 1)],
        ["envelope inside", "WW1:SYNTHETIC-REF-0001"],
        ["number", 42],
        ["object", {}]

    ];

    for (const [label, reference] of invalidReferences) {

        const rejection = expectThrow(
            () => formatPaymentReference(reference),
            "PaymentReferenceFormatError",
            `formatting must refuse: ${label}`
        );

        check(
            rejection.code === "PAYMENT_REFERENCE_FORMAT_INVALID"
                && Object.keys(rejection.details).sort().join(",") === "reason,referenceLength",
            `${label} must be refused with a defect reason and length only`
        );

    }

    // A rejected value is never echoed back through the error details.
    const padded = expectThrow(
        () => formatPaymentReference(" REF-0001 "),
        "PaymentReferenceFormatError",
        "a padded reference must be refused"
    );

    check(
        !JSON.stringify(padded.toJSON()).includes("REF-0001"),
        "a rejection must never echo the rejected reference"
    );

    // Unsupported comment shapes (binary / encrypted / contract payloads) are
    // only ever rejected by the codec: it reads comments, not payloads.
    check(
        extractPaymentReference({ type: "binary_comment", hex_comment: "WW1:SYNTHETIC-REF-0001" }) === null,
        "a decoded payload object is not a comment"
    );

    console.log("[13b] payment reference rejection rules: PASS");

}

// 13c. Exact reference matching, duplicate references and intent immutability.
{

    // A transfer whose reference came out of the codec matches only the intent
    // configured with exactly that reference.
    const reference = extractPaymentReference(formatPaymentReference(FIXTURE_PAYMENT_REFERENCE));

    const transfer = normalizeIncomingTransferRecord(
        providerRecord({ comment: reference }),
        { network: FIXTURE_NETWORK, providerId: FIXTURE_PROVIDER_ID }
    );

    check(
        transfer.paymentReference === FIXTURE_PAYMENT_REFERENCE
            && transfer.paymentComment === FIXTURE_PAYMENT_REFERENCE,
        "the bare reference must be the payment reference of the observation"
    );

    const match = matchIncomingTransferToIntent(transfer, buildIntent());

    check(
        match.matched === true
            && match.paymentReference === FIXTURE_PAYMENT_REFERENCE
            && match.mismatches.length === 0,
        "a codec-derived reference must match its intent exactly"
    );

    // A near-miss reference never matches: no prefix, envelope or similarity
    // is ever resolved by guessing.
    //
    // Boundary note: the Phase 2 default extractor trims a provider-supplied
    // reference field, but the Toncenter path can never rely on that, because
    // the mapper strips and validates the `WW1:` envelope itself and rejects
    // every comment that is not exactly that envelope.
    const nearMissCases = [

        ["envelope not stripped", `WW1:${FIXTURE_PAYMENT_REFERENCE}`],
        ["one character off", "SYNTHETIC-REF-0002"],
        ["case differs", "synthetic-ref-0001"]

    ];

    for (const [label, comment] of nearMissCases) {

        const nearMiss = normalizeIncomingTransferRecord(
            providerRecord({ comment }),
            { network: FIXTURE_NETWORK, providerId: FIXTURE_PROVIDER_ID }
        );

        const nearMissMatch = matchIncomingTransferToIntent(nearMiss, buildIntent());

        check(
            nearMissMatch.matched === false
                && (nearMissMatch.reason === TRANSFER_MATCH_REASON.PAYMENT_REFERENCE_MISMATCH
                    || nearMissMatch.reason === TRANSFER_MATCH_REASON.PAYMENT_REFERENCE_MISSING),
            `${label} must never match the intent`
        );

    }

    // The codec itself never trims an envelope: a padded comment is refused,
    // so no provider can smuggle a reference in through padding.
    check(
        extractPaymentReference(`WW1:${FIXTURE_PAYMENT_REFERENCE} `) === null
            && extractPaymentReference(` WW1:${FIXTURE_PAYMENT_REFERENCE}`) === null,
        "the codec must never trim a comment envelope"
    );

    // Duplicate reference: two distinct transaction identities claiming the
    // same reference are rejected, never attributed to one of them.
    const duplicateAdapter = buildAdapter({

        records: [

            providerRecord({
                transactionId: "synthetic-tx-0001",
                comment: FIXTURE_PAYMENT_REFERENCE
            }),

            providerRecord({
                transactionId: "synthetic-tx-0002",
                comment: FIXTURE_PAYMENT_REFERENCE
            })

        ]

    });

    const collision = expectThrow(
        () => duplicateAdapter.observeIncomingTransactions(),
        "PaymentReferenceCollisionError",
        "two transactions with the same reference must be rejected"
    );

    check(
        collision.details.paymentReference === FIXTURE_PAYMENT_REFERENCE
            && duplicateAdapter.observedTransactionCount === 0,
        "a duplicate reference must be rejected before anything is observed"
    );

    // Two different references from the codec are two different observations.
    const distinctAdapter = buildAdapter({

        records: [

            providerRecord({
                transactionId: "synthetic-tx-0001",
                comment: extractPaymentReference(formatPaymentReference(FIXTURE_PAYMENT_REFERENCE))
            }),

            providerRecord({
                transactionId: "synthetic-tx-0002",
                comment: extractPaymentReference(formatPaymentReference("SYNTHETIC-REF-0002"))
            })

        ]

    });

    const distinct = distinctAdapter.observeIncomingTransactions();

    check(
        distinct.observed.length === 2
            && distinct.observed.map((entry) => entry.paymentReference).join(",")
                === `${FIXTURE_PAYMENT_REFERENCE},SYNTHETIC-REF-0002`,
        "distinct references must produce distinct observations"
    );

    // Replay protection is unchanged by the codec: an identical repeat of the
    // same transaction and reference is idempotent.
    const replayAdapter = buildAdapter({

        records: [providerRecord({ comment: FIXTURE_PAYMENT_REFERENCE })]

    });

    const first = replayAdapter.observeIncomingTransactions();
    const second = replayAdapter.observeIncomingTransactions();

    check(
        first.observed.length === 1
            && second.observed.length === 0
            && second.replays.length === 1
            && replayAdapter.observedTransactionCount === 1,
        "an exact replay must stay idempotent"
    );

    // A reference-less observation can never match an intent that expects one,
    // and a reference never turns into a confirmed payment.
    const anonymousTransfer = normalizeIncomingTransferRecord(
        providerRecord({ comment: undefined }),
        { network: FIXTURE_NETWORK, providerId: FIXTURE_PROVIDER_ID }
    );

    const anonymousMatch = matchIncomingTransferToIntent(anonymousTransfer, buildIntent());

    check(
        anonymousMatch.matched === false
            && anonymousMatch.reason === TRANSFER_MATCH_REASON.PAYMENT_REFERENCE_MISSING,
        "a transfer without a reference must never match by guessing"
    );

    // The intent is never mutated, confirmed or executed by the codec path.
    const intent = buildIntent();

    const before = intent.toRecord();

    const evaluation = matchIncomingTransferToIntent(transfer, intent);

    check(evaluation.matched === true, "the evaluation must be a match (evaluation only)");

    check(
        intent.state === "PENDING"
            && intent.transactionId === null
            && intent.updatedAt === null
            && Object.isFrozen(intent)
            && JSON.stringify(intent.toRecord()) === JSON.stringify(before),
        "the payment intent must stay byte-identical and unconfirmed"
    );

    check(
        isPaymentConfirmationDisposition("observation-only") === false,
        "no codec result can ever be a payment confirmation"
    );

    // The codec exposes no write, transfer or confirmation operation.
    check(
        Object.keys(paymentReferenceCodec).every(
            (name) => !/send|broadcast|sign|deploy|transfer|burn|confirm|settle|credit|refund/i.test(name)
        ),
        "the payment reference codec must expose no write or confirmation operation"
    );

    console.log("[13c] exact match, duplicates and immutability: PASS");

}

console.log(
    `\nIsolated incoming-transfer adapter tests passed | assertions=${checksPassed}`
        + ` | schemaVersion=1`
        + ` | networks=testnet,mainnet`
        + ` | disposition=observation-only`
        + ` | commentFormat=WW1:<paymentReference>`
        + ` | sendEnabled=false`
        + ` | confirmationEnabled=false`
);

export { checksPassed };
