/**
 * Phase 2 — Normalized incoming transfer representation.
 *
 * The single internal shape every provider record is normalized into. It is
 * provider-independent, immutable, and carries exactly the fields needed to
 * evaluate a possible match against a Phase 1 payment intent:
 *
 *   - network ........................ the chain network (validated against
 *                                    `SUPPORTED_INCOMING_TRANSFER_NETWORKS`)
 *   - destinationWalletAddress ....... the receiving wallet address
 *   - destinationWalletId ............ optional wallet id when the provider
 *                                    account maps to one
 *   - senderAddress .................. the paying address
 *   - amountAtomic ................... exact positive safe integer
 *   - asset .......................... asset identifier (matched exactly)
 *   - transactionId .................. deterministic, network-scoped identity
 *                                    (see `deriveIncomingTransactionId`);
 *                                    amount, destination, sender and
 *                                    timestamps are never part of it
 *   - providerTransactionIdentity .... raw provider identity preserved for
 *                                    later idempotency checks — and nothing
 *                                    else from the raw response
 *   - transactionTime ................ integer epoch milliseconds
 *   - paymentReference / paymentComment  reference extracted from the
 *                                    transaction, when present (never guessed)
 *   - providerConfirmed .............. provider-reported confirmation state;
 *                                    observation alone never confirms payment
 *
 * Secret-bearing fields are never read, retained, or reconstructed here: the
 * constructor accepts only the whitelisted fields above.
 */

import { PaymentValidationError } from "../PaymentErrors.js";

import {
    INCOMING_TRANSACTION_ID_PREFIX,
    INCOMING_TRANSFER_DIRECTION,
    INCOMING_TRANSFER_SCHEMA_VERSION,
    TRANSFER_REJECTION_REASON
} from "./IncomingTransferConstants.js";

import {
    isSupportedNetwork,
    normalizeNetwork,
    parseAtomicAmount,
    parseTransactionTime
} from "./IncomingTransferIdentity.js";

import {
    TransactionIdentityError,
    TransactionRecordIncompleteError,
    TransactionRecordRejectedError
} from "./IncomingTransferErrors.js";

function assertNonEmptyString(value, field) {

    if (typeof value !== "string" || value.trim() === "") {

        throw new TransactionRecordIncompleteError(
            `${field} must be a non-empty string`
        );

    }

}

function assertDerivedTransactionId(value) {

    if (typeof value !== "string"
        || !value.startsWith(`${INCOMING_TRANSACTION_ID_PREFIX}`)
        || value.length !== INCOMING_TRANSACTION_ID_PREFIX.length + 64) {

        throw new TransactionIdentityError(
            "transactionId must be a derived adapter identity "
                + `(${INCOMING_TRANSACTION_ID_PREFIX}<sha256 hex>)`,
            { transactionId: value }
        );

    }

}

export class IncomingTransfer {

    constructor({
        network,
        transactionId,
        providerTransactionIdentity,
        destinationWalletAddress,
        destinationWalletId = null,
        senderAddress,
        amountAtomic,
        asset,
        transactionTime,
        paymentReference = null,
        paymentComment = null,
        providerConfirmed = null,
        observedAt = null
    }) {

        const normalizedNetwork = normalizeNetwork(network);

        if (!isSupportedNetwork(normalizedNetwork)) {

            throw new TransactionRecordRejectedError(
                `unsupported transfer network: ${network}`,
                {
                    network,
                    reason: TRANSFER_REJECTION_REASON.NETWORK_UNSUPPORTED
                }
            );

        }

        assertDerivedTransactionId(transactionId);

        if (!providerTransactionIdentity
            || typeof providerTransactionIdentity !== "object") {

            throw new TransactionRecordIncompleteError(
                "providerTransactionIdentity must be an object"
            );

        }

        assertNonEmptyString(
            providerTransactionIdentity.accountId,
            "providerTransactionIdentity.accountId"
        );

        assertNonEmptyString(
            providerTransactionIdentity.transactionId,
            "providerTransactionIdentity.transactionId"
        );

        const providerId = typeof providerTransactionIdentity.providerId === "string"
            && providerTransactionIdentity.providerId.trim() !== ""
            ? providerTransactionIdentity.providerId.trim()
            : "provider";

        assertNonEmptyString(destinationWalletAddress, "destinationWalletAddress");
        assertNonEmptyString(senderAddress, "senderAddress");
        assertNonEmptyString(asset, "asset");

        if (destinationWalletId !== null) {

            assertNonEmptyString(destinationWalletId, "destinationWalletId");

        }

        const parsedAmount = parseAtomicAmount(amountAtomic);

        const parsedTime = parseTransactionTime(transactionTime);

        if (paymentReference !== null) {

            assertNonEmptyString(paymentReference, "paymentReference");

        }

        if (paymentComment !== null && typeof paymentComment !== "string") {

            throw new TransactionRecordIncompleteError(
                "paymentComment must be a string or null"
            );

        }

        if (providerConfirmed !== null && typeof providerConfirmed !== "boolean") {

            throw new TransactionRecordIncompleteError(
                "providerConfirmed must be a boolean or null"
            );

        }

        this.schemaVersion = INCOMING_TRANSFER_SCHEMA_VERSION;

        this.network = normalizedNetwork;

        this.direction = INCOMING_TRANSFER_DIRECTION;

        this.transactionId = transactionId;

        this.providerTransactionIdentity = Object.freeze({
            providerId,
            accountId: providerTransactionIdentity.accountId.trim(),
            transactionId: providerTransactionIdentity.transactionId.trim()
        });

        this.destinationWalletAddress = destinationWalletAddress.trim();

        this.destinationWalletId = destinationWalletId === null
            ? null
            : destinationWalletId.trim();

        this.senderAddress = senderAddress.trim();

        this.amountAtomic = parsedAmount;

        this.asset = asset.trim();

        this.transactionTime = parsedTime;

        this.paymentReference = paymentReference === null
            ? null
            : paymentReference.trim();

        this.paymentComment = paymentComment === null ? null : paymentComment;

        this.providerConfirmed = providerConfirmed;

        this.observedAt = Number.isInteger(observedAt) ? observedAt : null;

        Object.freeze(this);

    }

    /**
     * Canonical fingerprint of everything except `observedAt`. Used to tell
     * an identical replay of the same provider transaction apart from a
     * contradictory one.
     *
     * @returns {string}
     */
    payloadFingerprint() {

        return JSON.stringify([

            this.schemaVersion,
            this.network,
            this.direction,
            this.transactionId,
            this.providerTransactionIdentity.providerId,
            this.providerTransactionIdentity.accountId,
            this.providerTransactionIdentity.transactionId,
            this.destinationWalletAddress,
            this.destinationWalletId,
            this.senderAddress,
            this.amountAtomic,
            this.asset,
            this.transactionTime,
            this.paymentReference,
            this.paymentComment,
            this.providerConfirmed

        ]);

    }

    /**
     * Serializable record. Contains identity and observation fields only —
     * never raw provider responses and never secret material.
     */
    toRecord() {

        return Object.freeze({
            schemaVersion: this.schemaVersion,
            network: this.network,
            direction: this.direction,
            transactionId: this.transactionId,
            providerTransactionIdentity: Object.freeze({
                ...this.providerTransactionIdentity
            }),
            destinationWalletAddress: this.destinationWalletAddress,
            destinationWalletId: this.destinationWalletId,
            senderAddress: this.senderAddress,
            amountAtomic: this.amountAtomic,
            asset: this.asset,
            transactionTime: this.transactionTime,
            paymentReference: this.paymentReference,
            paymentComment: this.paymentComment,
            providerConfirmed: this.providerConfirmed,
            observedAt: this.observedAt
        });

    }

    /**
     * Rebuild from a record with full validation (fail closed).
     *
     * @param {object} record
     * @returns {IncomingTransfer}
     */
    static fromRecord(record) {

        if (!record || typeof record !== "object") {

            throw new PaymentValidationError(
                "incoming transfer record must be a non-null object"
            );

        }

        return new IncomingTransfer(record);

    }

}
