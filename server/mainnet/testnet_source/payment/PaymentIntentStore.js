import { durableWriteJson } from './DurableJson.js';
/**
 * Phase 1 — Durable payment intent store.
 *
 * R4 — every player payment is a distinct, PERSISTENT payment intent.
 *
 * Durable storage follows the existing server convention (local JSON data under
 * `server/data/...` with atomic temp-file + rename writes, same as
 * AdvertisementStorage). It is deliberately NOT an in-memory-only ledger.
 *
 * Layout:
 *   <dataDir>/payment-intents/<paymentReference>.json
 *
 * On `initialize()` the store scans that directory, validates every record
 * (fail closed on corruption), and rebuilds in-memory indexes for:
 *   - paymentReference -> PaymentIntent      (identity, R6)
 *   - transactionId -> paymentReference      (idempotency, R7)
 *   - roomId -> Set<paymentReference>        (room obligations, R8)
 */

import {
    closeSync,
    existsSync,
    fsyncSync,
    linkSync,
    mkdirSync,
    openSync,
    readdirSync,
    readFileSync,
    renameSync,
    unlinkSync,
    writeFileSync
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

import { PAYMENT_INTENT_SCHEMA_VERSION } from "./RoomPaymentConstants.js";
import { PaymentIntent } from "./PaymentIntent.js";
import {
    CorruptedPaymentRecordError,
    PaymentIntentNotFoundError,
    PaymentReferenceCollisionError,
    PaymentStorageError,
    PaymentValidationError
} from "./PaymentErrors.js";

export const PAYMENT_INTENT_STORAGE_SCHEMA_VERSION = 1;

const PAYMENT_INTENT_RECORD_FIELDS = Object.freeze([
    "schemaVersion",
    "paymentReference",
    "roomId",
    "playerId",
    "network",
    "destinationWalletId",
    "destinationWalletAddress",
    "expectedSender",
    "amountAtomic",
    "asset",
    "createdAt",
    "expiresAt",
    "roomDeadlineMs",
    "state",
    "transactionId",
    "updatedAt"
]);

const IMMUTABLE_PAYMENT_INTENT_FIELDS = Object.freeze([
    "schemaVersion",
    "paymentReference",
    "roomId",
    "playerId",
    "network",
    "destinationWalletId",
    "destinationWalletAddress",
    "expectedSender",
    "amountAtomic",
    "asset",
    "createdAt",
    "expiresAt",
    "roomDeadlineMs"
]);

/**
 * @param {string} filePath
 * @param {object} payload
 */
function atomicWriteJson(filePath, payload) { durableWriteJson(filePath, payload); }

function atomicCreateJson(filePath, payload) {
    try { durableWriteJson(filePath, payload, {exclusive:true}); return true; }
    catch (error) { if (error.code === 'EEXIST') return false; throw error; }
}

export class PaymentIntentStore {

    constructor({
        dataDir,
        logger = null,
        nowProvider = Date.now
    } = {}) {

        if (typeof dataDir !== "string" || dataDir.trim() === "") {

            throw new PaymentValidationError(
                "dataDir must be a non-empty string"
            );

        }

        this._dataDir = dataDir;

        this._logger = logger;

        this._now = nowProvider;

        this._intentsDir = join(dataDir, "payment-intents");

        /** @type {Map<string, PaymentIntent>} */
        this._byReference = new Map();

        /** @type {Map<string, string>} transactionId -> paymentReference */
        this._transactionIndex = new Map();

        this._initialized = false;

    }

    get dataDir() {

        return this._dataDir;

    }

    get intentsDir() {

        return this._intentsDir;

    }

    get size() {

        return this._byReference.size;

    }

    /**
     * Create the storage directory and rebuild indexes from disk.
     */
    initialize() {

        mkdirSync(this._intentsDir, { recursive: true });

        this._byReference.clear();

        this._transactionIndex.clear();

        for (const fileName of readdirSync(this._intentsDir)) {

            if (!fileName.endsWith(".json")) {

                continue;

            }

            const filePath = join(this._intentsDir, fileName);

            this._loadFromDisk(filePath);

        }

        this._initialized = true;

        this._logInfo(
            `PaymentIntentStore ready | intents=${this._byReference.size}`
                + ` | transactions=${this._transactionIndex.size}`
                + ` | dir=${this._intentsDir}`
        );

    }

    _loadFromDisk(filePath) {

        let parsed;

        try {

            parsed = JSON.parse(readFileSync(filePath, "utf8"));

        } catch (error) {

            throw new CorruptedPaymentRecordError(
                fileNameOf(filePath),
                `unreadable json | ${error?.message ?? error}`
            );

        }

        if (parsed?.schemaVersion !== PAYMENT_INTENT_SCHEMA_VERSION) {

            throw new CorruptedPaymentRecordError(
                fileNameOf(filePath),
                `unsupported schemaVersion ${parsed?.schemaVersion}`
            );

        }

        const intent = PaymentIntent.fromRecord(parsed);

        if (fileNameOf(filePath) !== `${intent.paymentReference}.json`) {

            throw new CorruptedPaymentRecordError(
                fileNameOf(filePath),
                "file name does not match the persisted payment reference"
            );

        }

        // Duplicate reference detection across the rebuilt ledger (R6).
        if (this._byReference.has(intent.paymentReference)) {

            throw new PaymentReferenceCollisionError(intent.paymentReference);

        }

        this._byReference.set(intent.paymentReference, intent);

        if (intent.transactionId !== null) {

            const creditedTo = this._transactionIndex.get(intent.transactionId);

            if (creditedTo && creditedTo !== intent.paymentReference) {

                throw new CorruptedPaymentRecordError(
                    fileNameOf(filePath),
                    `transaction ${intent.transactionId} already credited to `
                        + `${creditedTo}`
                );

            }

            this._transactionIndex.set(
                intent.transactionId,
                intent.paymentReference
            );

        }

    }

    // -------------------------------------------------------------------------
    // Identity lookups
    // -------------------------------------------------------------------------

    /**
     * @param {string} paymentReference
     * @returns {boolean}
     */
    has(paymentReference) {

        return this._byReference.has(paymentReference);

    }

    /**
     * R6 — identity is the unique payment reference, never amount +
     * destination + approximate timestamp.
     *
     * @param {string} paymentReference
     * @returns {PaymentIntent|null}
     */
    get(paymentReference) {

        this._assertInitialized();

        return this._byReference.get(paymentReference) ?? null;

    }

    /**
     * @param {string} paymentReference
     * @returns {PaymentIntent}
     */
    require(paymentReference) {

        const intent = this.get(paymentReference);

        if (!intent) {

            throw new PaymentIntentNotFoundError(paymentReference);

        }

        return intent;

    }

    /**
     * @param {string} roomId
     * @returns {Array<PaymentIntent>}
     */
    listForRoom(roomId) {

        return this.list().filter((intent) => intent.roomId === roomId);

    }

    /**
     * @returns {Array<PaymentIntent>}
     */
    list() {

        return [...this._byReference.values()];

    }

    /**
     * R7 — the payment intent a transaction identifier was credited to.
     *
     * @param {string} transactionId
     * @returns {PaymentIntent|null}
     */
    findByTransactionId(transactionId) {

        const reference = this._transactionIndex.get(transactionId);

        return reference ? this._byReference.get(reference) ?? null : null;

    }

    /**
     * @param {string} transactionId
     * @returns {boolean}
     */
    hasTransactionBeenCredited(transactionId) {

        return this._transactionIndex.has(transactionId);

    }

    /**
     * R7 — transaction identifiers already credited to another intent.
     *
     * @returns {Map<string, string>}
     */
    listCreditedTransactions() {

        return new Map(this._transactionIndex);

    }

    // -------------------------------------------------------------------------
    // Writes
    // -------------------------------------------------------------------------

    /**
     * Persist a NEW payment intent. Duplicate references are rejected so a
     * player payment can never be silently overwritten.
     *
     * @param {PaymentIntent|object} intentOrRecord
     * @returns {PaymentIntent}
     */
    save(intentOrRecord) {

        this._assertInitialized();

        const intent = intentOrRecord instanceof PaymentIntent
            ? intentOrRecord
            : PaymentIntent.fromRecord(intentOrRecord);

        if (this._byReference.has(intent.paymentReference)) {

            throw new PaymentReferenceCollisionError(intent.paymentReference);

        }

        this._writeNewToDisk(intent);

        this._byReference.set(intent.paymentReference, intent);

        return intent;

    }

    /**
     * Persist an UPDATE to an existing payment intent.
     *
     * R7 — a transaction identifier cannot be credited twice: the write is
     * rejected when the new identifier is already bound to a different intent.
     *
     * @param {PaymentIntent|object} intentOrRecord
     * @returns {PaymentIntent}
     */
    update(intentOrRecord) {

        this._assertInitialized();

        const next = intentOrRecord instanceof PaymentIntent
            ? intentOrRecord
            : PaymentIntent.fromRecord(intentOrRecord);

        const existing = this._byReference.get(next.paymentReference);

        if (!existing) {

            throw new PaymentIntentNotFoundError(next.paymentReference);

        }

        const persisted = this._readExistingRecord(existing);

        for (const field of IMMUTABLE_PAYMENT_INTENT_FIELDS) {

            if (!Object.is(persisted[field], next[field])) {

                throw new PaymentValidationError(
                    `payment intent immutable field cannot be changed: ${field}`,
                    {
                        paymentReference: existing.paymentReference,
                        field
                    }
                );

            }

        }

        if (next.transactionId !== null) {

            const creditedTo = this._transactionIndex.get(next.transactionId);

            if (creditedTo && creditedTo !== next.paymentReference) {

                throw new PaymentReferenceCollisionError(creditedTo, {
                    transactionId: next.transactionId,
                    blockedBy: next.paymentReference
                });

            }

        }

        this._writeToDisk(next);

        this._byReference.set(next.paymentReference, next);

        if (next.transactionId !== null) {

            this._transactionIndex.set(next.transactionId, next.paymentReference);

        }

        return next;

    }

    _readExistingRecord(indexedIntent) {

        const paymentReference = indexedIntent.paymentReference;

        const filePath = this._intentPath(paymentReference);

        let parsed;

        try {

            parsed = JSON.parse(readFileSync(filePath, "utf8"));

        } catch (error) {

            throw new CorruptedPaymentRecordError(
                paymentReference,
                `unable to establish existing persisted identity | ${error?.message ?? error}`
            );

        }

        if (parsed?.schemaVersion !== PAYMENT_INTENT_SCHEMA_VERSION) {

            throw new CorruptedPaymentRecordError(
                paymentReference,
                `unsupported schemaVersion ${parsed?.schemaVersion}`
            );

        }

        let persistedIntent;

        try {

            persistedIntent = PaymentIntent.fromRecord(parsed);

        } catch (error) {

            throw new CorruptedPaymentRecordError(
                paymentReference,
                `invalid existing intent | ${error?.message ?? error}`
            );

        }

        if (fileNameOf(filePath) !== `${persistedIntent.paymentReference}.json`) {

            throw new CorruptedPaymentRecordError(
                paymentReference,
                "file name does not match the persisted payment reference"
            );

        }

        const record = persistedIntent.toRecord();
        const persistedKeys = Object.keys(parsed);

        if (persistedKeys.length !== PAYMENT_INTENT_RECORD_FIELDS.length
            || PAYMENT_INTENT_RECORD_FIELDS.some((field) => (
                !Object.prototype.hasOwnProperty.call(parsed, field)
            ))
            || persistedKeys.some((field) => (
                !PAYMENT_INTENT_RECORD_FIELDS.includes(field)
            ))) {

            throw new CorruptedPaymentRecordError(
                paymentReference,
                "existing intent record does not match the persisted schema"
            );

        }

        const indexedRecord = indexedIntent.toRecord();

        if (PAYMENT_INTENT_RECORD_FIELDS.some((field) => (
            !Object.is(record[field], indexedRecord[field])
        ))) {

            throw new CorruptedPaymentRecordError(
                paymentReference,
                "existing persisted record disagrees with the in-memory index"
            );

        }

        return record;

    }

    /**
     * @param {string} paymentReference
     * @returns {boolean}
     */
    delete(paymentReference) {

        this._assertInitialized();

        const existing = this._byReference.get(paymentReference);

        if (!existing) {

            return false;

        }

        const filePath = this._intentPath(paymentReference);

        if (existsSync(filePath)) {

            try {

                unlinkSync(filePath);

            } catch (error) {

                throw new PaymentStorageError(
                    `failed to delete payment intent file: ${error?.message ?? error}`,
                    { paymentReference }
                );

            }

        }

        this._byReference.delete(paymentReference);

        for (const [transactionId, reference] of this._transactionIndex.entries()) {

            if (reference === paymentReference) {

                this._transactionIndex.delete(transactionId);

            }

        }

        return true;

    }

    _writeToDisk(intent) {

        try {

            atomicWriteJson(this._intentPath(intent.paymentReference), intent.toRecord());

        } catch (error) {

            throw new PaymentStorageError(
                `failed to persist payment intent: ${error?.message ?? error}`,
                { paymentReference: intent.paymentReference }
            );

        }

    }

    _writeNewToDisk(intent) {

        try {

            if (!atomicCreateJson(this._intentPath(intent.paymentReference), intent.toRecord())) {

                throw new PaymentReferenceCollisionError(intent.paymentReference);

            }

        } catch (error) {

            if (error instanceof PaymentReferenceCollisionError) {

                throw error;

            }

            throw new PaymentStorageError(
                `failed to persist payment intent: ${error?.message ?? error}`,
                { paymentReference: intent.paymentReference }
            );

        }

    }

    _intentPath(paymentReference) {

        return join(this._intentsDir, `${paymentReference}.json`);

    }

    _assertInitialized() {

        if (!this._initialized) {

            throw new PaymentStorageError("PaymentIntentStore is not initialized");

        }

    }

    _logInfo(message) {

        this._logger?.info?.(message);

    }

}

/**
 * @param {string} filePath
 * @returns {string}
 */
function fileNameOf(filePath) {

    const index = filePath.lastIndexOf("\\");

    const slash = filePath.lastIndexOf("/");

    return filePath.slice(Math.max(index, slash) + 1);

}

export { PAYMENT_INTENT_SCHEMA_VERSION };
