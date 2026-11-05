/**
 * Phase 2 — Pure normalization of a provider transaction record into the
 * internal `IncomingTransfer` representation.
 *
 * Normalization is fail-closed. A record is rejected unless it satisfies the
 * declared provider contract (`INCOMING_TRANSFER_PROVIDER_CONTRACT`):
 *
 *   - non-null object, carrying none of the forbidden secret-bearing fields;
 *   - every required field present;
 *   - direction (when present) exactly "incoming";
 *   - network supported and matching the adapter scope;
 *   - not an aborted/failed transaction (contradictory as an incoming
 *     transfer);
 *   - amount an exact positive integer atomic value (no float conversion);
 *   - transaction time a positive integer epoch-milliseconds value.
 *
 * Only whitelisted fields are carried into the normalized record. Anything
 * else in the raw response — including credential-like fields — is dropped,
 * never retained.
 */

import {
    INCOMING_TRANSFER_DIRECTION,
    INCOMING_TRANSFER_PROVIDER_CONTRACT,
    TRANSFER_REJECTION_REASON
} from "./IncomingTransferConstants.js";

import { deriveIncomingTransactionId, isSupportedNetwork, normalizeNetwork, parseAtomicAmount, parseTransactionTime } from "./IncomingTransferIdentity.js";

import { IncomingTransfer } from "./IncomingTransfer.js";

import {
    SecretBearingRecordError,
    TransactionRecordIncompleteError,
    TransactionRecordRejectedError
} from "./IncomingTransferErrors.js";

/**
 * Default payment-reference extraction: the transfer comment, trimmed.
 *
 * The reference is taken verbatim from the transaction record — it is never
 * derived from an address, amount or timestamp pattern, and never guessed.
 * A provider that encodes references differently must inject its own
 * extractor, which the adapter treats as part of the declared contract.
 *
 * @param {object} rawRecord
 * @returns {string|null}
 */
export function defaultPaymentReferenceExtractor(rawRecord) {

    const comment = rawRecord?.comment;

    if (comment === undefined || comment === null) {

        return null;

    }

    if (typeof comment !== "string") {

        throw new TransactionRecordRejectedError(
            "comment must be a string when present",
            { comment, reason: TRANSFER_REJECTION_REASON.RECORD_CONTRADICTORY }
        );

    }

    const trimmed = comment.trim();

    return trimmed === "" ? null : trimmed;

}

/**
 * @param {unknown} rawRecord
 * @returns {void}
 */
function assertNoSecretBearingFields(rawRecord) {

    for (const forbidden of INCOMING_TRANSFER_PROVIDER_CONTRACT
        .forbiddenRecordFields) {

        if (Object.prototype.hasOwnProperty.call(rawRecord, forbidden)) {

            throw new SecretBearingRecordError(forbidden);

        }

    }

}

/**
 * @param {object} rawRecord
 * @returns {void}
 */
function assertRequiredFields(rawRecord) {

    const missingFields = INCOMING_TRANSFER_PROVIDER_CONTRACT
        .requiredRecordFields
        .filter((field) => rawRecord[field] === undefined
            || rawRecord[field] === null);

    if (missingFields.length > 0) {

        throw new TransactionRecordIncompleteError(
            `provider transaction record is missing required fields: `
                + `${missingFields.join(", ")}`,
            {
                missingFields,
                reason: TRANSFER_REJECTION_REASON.RECORD_FIELDS_INCOMPLETE
            }
        );

    }

}

/**
 * Normalize one provider transaction record.
 *
 * @param {unknown} rawRecord
 * @param {{
 *   network: string,
 *   providerId?: string,
 *   paymentReferenceExtractor?: (record: object) => string|null,
 *   now?: number
 * }} options
 * @returns {IncomingTransfer}
 */
export function normalizeIncomingTransferRecord(rawRecord, options = {}) {

    if (!rawRecord || typeof rawRecord !== "object" || Array.isArray(rawRecord)) {

        throw new TransactionRecordIncompleteError(
            "provider transaction record must be a non-null object",
            { reason: TRANSFER_REJECTION_REASON.RECORD_FIELDS_INCOMPLETE }
        );

    }

    assertNoSecretBearingFields(rawRecord);

    assertRequiredFields(rawRecord);

    const scopeNetwork = normalizeNetwork(options.network);

    if (!isSupportedNetwork(scopeNetwork)) {

        throw new TransactionRecordRejectedError(
            `adapter network is not supported: ${options.network}`,
            {
                network: options.network,
                reason: TRANSFER_REJECTION_REASON.NETWORK_UNSUPPORTED
            }
        );

    }

    const recordNetwork = normalizeNetwork(rawRecord.network);

    if (!isSupportedNetwork(recordNetwork)) {

        throw new TransactionRecordRejectedError(
            `unsupported transfer network: ${rawRecord.network}`,
            {
                network: rawRecord.network,
                reason: TRANSFER_REJECTION_REASON.NETWORK_UNSUPPORTED
            }
        );

    }

    if (recordNetwork !== scopeNetwork) {

        throw new TransactionRecordRejectedError(
            `provider record network ${recordNetwork} is contradictory for an`
                + ` adapter scoped to ${scopeNetwork}`,
            {
                network: recordNetwork,
                expectedNetwork: scopeNetwork,
                reason: TRANSFER_REJECTION_REASON.RECORD_CONTRADICTORY
            }
        );

    }

    if (rawRecord.direction !== undefined && rawRecord.direction !== null) {

        if (typeof rawRecord.direction !== "string"
            || rawRecord.direction.trim().toLowerCase()
                !== INCOMING_TRANSFER_DIRECTION) {

            throw new TransactionRecordRejectedError(
                `unsupported transfer direction: ${rawRecord.direction}`
                    + ` (only "${INCOMING_TRANSFER_DIRECTION}" is accepted)`,
                {
                    direction: rawRecord.direction,
                    reason: TRANSFER_REJECTION_REASON.DIRECTION_UNSUPPORTED
                }
            );

        }

    }

    if (rawRecord.aborted === true) {

        throw new TransactionRecordRejectedError(
            "aborted provider transaction cannot be normalized as an"
                + " incoming transfer",
            {
                transactionId: rawRecord.transactionId,
                reason: TRANSFER_REJECTION_REASON.RECORD_CONTRADICTORY
            }
        );

    }

    const transactionId = deriveIncomingTransactionId({
        network: recordNetwork,
        providerId: options.providerId,
        accountId: rawRecord.accountId,
        transactionId: rawRecord.transactionId
    });

    const amountAtomic = parseAtomicAmount(rawRecord.amountAtomic);

    const transactionTime = parseTransactionTime(rawRecord.transactionTime);

    const extractReference = typeof options.paymentReferenceExtractor === "function"
        ? options.paymentReferenceExtractor
        : defaultPaymentReferenceExtractor;

    const paymentReference = extractReference(rawRecord);

    if (paymentReference !== null
        && (typeof paymentReference !== "string"
            || paymentReference.trim() === "")) {

        throw new TransactionRecordRejectedError(
            "payment reference extractor must return a non-empty string or null",
            {
                paymentReference,
                reason: TRANSFER_REJECTION_REASON.RECORD_CONTRADICTORY
            }
        );

    }

    let paymentComment = null;

    if (rawRecord.comment !== undefined && rawRecord.comment !== null) {

        paymentComment = rawRecord.comment;

    }

    let providerConfirmed = null;

    if (rawRecord.confirmed !== undefined && rawRecord.confirmed !== null) {

        if (typeof rawRecord.confirmed !== "boolean") {

            throw new TransactionRecordRejectedError(
                "confirmed must be a boolean when present",
                {
                    confirmed: rawRecord.confirmed,
                    reason: TRANSFER_REJECTION_REASON.RECORD_CONTRADICTORY
                }
            );

        }

        providerConfirmed = rawRecord.confirmed;

    }

    let destinationWalletId = null;

    if (rawRecord.destinationWalletId !== undefined
        && rawRecord.destinationWalletId !== null) {

        if (typeof rawRecord.destinationWalletId !== "string"
            || rawRecord.destinationWalletId.trim() === "") {

            throw new TransactionRecordIncompleteError(
                "destinationWalletId must be a non-empty string when present"
            );

        }

        destinationWalletId = rawRecord.destinationWalletId.trim();

    }

    // Address and asset identity fields must be usable strings. (The provider
    // account/transaction identity is already validated by identity
    // derivation above.)
    if (typeof rawRecord.sourceAddress !== "string"
        || rawRecord.sourceAddress.trim() === ""
        || typeof rawRecord.destinationAddress !== "string"
        || rawRecord.destinationAddress.trim() === ""
        || typeof rawRecord.asset !== "string"
        || rawRecord.asset.trim() === "") {

        throw new TransactionRecordIncompleteError(
            "provider transaction record address/asset fields must be"
                + " non-empty strings",
            {
                reason: TRANSFER_REJECTION_REASON.RECORD_FIELDS_INCOMPLETE
            }
        );

    }

    return new IncomingTransfer({
        network: recordNetwork,
        transactionId,
        providerTransactionIdentity: {
            providerId: options.providerId,
            accountId: rawRecord.accountId,
            transactionId: rawRecord.transactionId
        },
        destinationWalletAddress: rawRecord.destinationAddress,
        destinationWalletId,
        senderAddress: rawRecord.sourceAddress,
        amountAtomic,
        asset: rawRecord.asset,
        transactionTime,
        paymentReference,
        paymentComment,
        providerConfirmed,
        observedAt: Number.isInteger(options.now) ? options.now : null
    });

}
