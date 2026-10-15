/**
 * Isolated SQLite implementation of the PaymentIntentStore contract.
 *
 * `intentsDir` is retained for API compatibility and returns `databasePath`,
 * since SQLite stores records in tables rather than one JSON file per intent.
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import { PAYMENT_INTENT_SCHEMA_VERSION } from "./RoomPaymentConstants.js";
import { PaymentIntent } from "./PaymentIntent.js";
import { canTransition } from "./PaymentIntentStatus.js";
import {
    CorruptedPaymentRecordError,
    InvalidPaymentStateTransitionError,
    PaymentIntentNotFoundError,
    PaymentReferenceCollisionError,
    PaymentStorageError,
    PaymentValidationError,
    TransactionAlreadyCreditedError
} from "./PaymentErrors.js";

export const SQLITE_PAYMENT_INTENT_SCHEMA_VERSION = 2;
export const SQLITE_PAYMENT_INTENT_BUSY_TIMEOUT_MS = 5_000;

const RECORD_FIELDS = Object.freeze([
    "schemaVersion", "paymentReference", "roomId", "playerId", "network",
    "destinationWalletId", "destinationWalletAddress", "expectedSender",
    "amountAtomic", "asset", "createdAt", "expiresAt", "roomDeadlineMs",
    "state", "transactionId", "updatedAt"
]);

const IMMUTABLE_FIELDS = Object.freeze([
    "schemaVersion", "paymentReference", "roomId", "playerId", "network",
    "destinationWalletId", "destinationWalletAddress", "expectedSender",
    "amountAtomic", "asset", "createdAt", "expiresAt", "roomDeadlineMs"
]);

const INSERT_COLUMNS = RECORD_FIELDS.join(", ");
const INSERT_VALUES = RECORD_FIELDS.map((field) => `@${field}`).join(", ");

const EXPECTED_SCHEMA_OBJECTS = Object.freeze([
    "payment_intent",
    "payment_intent_metadata",
    "payment_intent_room_idx",
    "payment_intent_tombstone"
]);

const PAYMENT_INTENT_COLUMNS = Object.freeze([
    ["paymentReference", "TEXT", 1, 1],
    ["schemaVersion", "INTEGER", 1, 0],
    ["roomId", "TEXT", 1, 0],
    ["playerId", "TEXT", 1, 0],
    ["network", "TEXT", 1, 0],
    ["destinationWalletId", "TEXT", 1, 0],
    ["destinationWalletAddress", "TEXT", 1, 0],
    ["expectedSender", "TEXT", 1, 0],
    ["amountAtomic", "INTEGER", 1, 0],
    ["asset", "TEXT", 1, 0],
    ["createdAt", "INTEGER", 1, 0],
    ["expiresAt", "INTEGER", 1, 0],
    ["roomDeadlineMs", "INTEGER", 1, 0],
    ["state", "TEXT", 1, 0],
    ["transactionId", "TEXT", 0, 0],
    ["updatedAt", "INTEGER", 0, 0],
    ["storage_version", "INTEGER", 1, 0]
]);

const TOMBSTONE_COLUMNS = Object.freeze([
    ["paymentReference", "TEXT", 1, 1],
    ["storage_version", "INTEGER", 1, 0]
]);

const METADATA_COLUMNS = Object.freeze([
    ["key", "TEXT", 1, 1],
    ["value", "INTEGER", 1, 0]
]);

function schemaError(message, details = {}) {

    return new PaymentStorageError(`invalid SQLite payment schema: ${message}`, details);

}

function quoteIdentifier(value) {

    return `"${String(value).replaceAll('"', '""')}"`;

}

function schemaObjects(db) {

    return db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master
        WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`).all();

}

function assertExactColumns(db, tableName, expectedColumns) {

    const actual = db.pragma(`table_info(${quoteIdentifier(tableName)})`);
    if (actual.length !== expectedColumns.length) {
        throw schemaError(`${tableName} has an unexpected column count`);
    }
    for (let index = 0; index < expectedColumns.length; index += 1) {
        const [name, type, notnull, pk] = expectedColumns[index];
        const column = actual[index];
        if (column.name !== name || String(column.type).toUpperCase() !== type
            || column.notnull !== notnull || column.pk !== pk) {
            throw schemaError(`${tableName}.${name} has an incompatible definition`);
        }
    }

}

function indexColumns(db, indexName) {

    return db.pragma(`index_info(${quoteIdentifier(indexName)})`)
        .sort((a, b) => a.seqno - b.seqno)
        .map((column) => column.name);

}

function assertPhysicalSchema(db) {

    const objects = schemaObjects(db);
    const objectNames = objects.map((object) => object.name).sort();
    if (JSON.stringify(objectNames) !== JSON.stringify([...EXPECTED_SCHEMA_OBJECTS].sort())) {
        throw schemaError("required schema objects are missing or unexpected", { objects: objectNames });
    }

    assertExactColumns(db, "payment_intent", PAYMENT_INTENT_COLUMNS);
    assertExactColumns(db, "payment_intent_tombstone", TOMBSTONE_COLUMNS);
    assertExactColumns(db, "payment_intent_metadata", METADATA_COLUMNS);

    const intentSql = objects.find((object) => object.name === "payment_intent")?.sql ?? "";
    const tombstoneSql = objects.find((object) => object.name === "payment_intent_tombstone")?.sql ?? "";
    const normalizeSql = (sql) => sql.toLowerCase().replace(/[\s"`\[\]]/g, "");
    if (!/check\(storage_version>=1\)/.test(normalizeSql(intentSql))
        || !/check\(storage_version>=1\)/.test(normalizeSql(tombstoneSql))) {
        throw schemaError("storage version checks are missing or incompatible");
    }

    const indexes = db.pragma("index_list('payment_intent')");
    const transactionUnique = indexes.some((index) => index.unique === 1 && index.partial === 0
        && indexColumns(db, index.name).join("\0") === "transactionId");
    if (!transactionUnique) {
        throw schemaError("payment_intent.transactionId is not uniquely indexed");
    }

    const roomIndex = indexes.find((index) => index.name === "payment_intent_room_idx");
    if (!roomIndex || roomIndex.unique !== 0 || roomIndex.partial !== 0
        || indexColumns(db, roomIndex.name).join("\0") !== "roomId\0paymentReference") {
        throw schemaError("room listing index is missing or incompatible");
    }

}

export class PaymentIntentStorageConflictError extends Error {

    constructor(paymentReference, expectedVersion, actualVersion) {

        super(`stale payment intent write: ${paymentReference} expected version `
            + `${expectedVersion}, current version ${actualVersion}`);
        this.name = "PaymentIntentStorageConflictError";
        this.code = "PAYMENT_INTENT_STORAGE_CONFLICT";
        this.details = Object.freeze({ paymentReference, expectedVersion, actualVersion });

    }

}

function isUniqueError(error) {

    return error?.code === "SQLITE_CONSTRAINT_UNIQUE"
        || error?.code === "SQLITE_CONSTRAINT_PRIMARYKEY";

}

function readRecord(row) {

    if (!row) return null;
    const record = {};
    for (const field of RECORD_FIELDS) record[field] = row[field];
    return record;

}

function toIntent(row) {

    if (!row) return null;
    const record = readRecord(row);
    if (record.schemaVersion !== PAYMENT_INTENT_SCHEMA_VERSION) {
        throw new CorruptedPaymentRecordError(record.paymentReference,
            `unsupported schemaVersion ${record.schemaVersion}`);
    }
    try {
        return PaymentIntent.fromStorageRecord(record, Number(row.storage_version));
    } catch (error) {
        throw new CorruptedPaymentRecordError(record.paymentReference,
            `invalid persisted intent | ${error?.message ?? error}`);
    }

}

function assertSupportedBusinessSchemaVersion(intent) {

    if (intent.schemaVersion !== PAYMENT_INTENT_SCHEMA_VERSION) {
        throw new PaymentValidationError(
            `unsupported payment intent schemaVersion: ${intent.schemaVersion}`,
            { paymentReference: intent.paymentReference, schemaVersion: intent.schemaVersion }
        );
    }

}

export class SqlitePaymentIntentStore {

    constructor({ databasePath, logger = null, nowProvider = Date.now, busyTimeoutMs = SQLITE_PAYMENT_INTENT_BUSY_TIMEOUT_MS } = {}) {

        if (typeof databasePath !== "string" || databasePath.trim() === ""
            || !isAbsolute(databasePath)) {
            throw new PaymentValidationError("databasePath must be an explicitly provided absolute path");
        }
        if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
            throw new PaymentValidationError("busyTimeoutMs must be a non-negative safe integer");
        }

        this._databasePath = resolve(databasePath);
        this._dataDir = dirname(this._databasePath);
        this._logger = logger;
        this._now = nowProvider;
        this._busyTimeoutMs = busyTimeoutMs;
        this._db = null;
        this._initialized = false;
    }

    get dataDir() { return this._dataDir; }
    get intentsDir() { return this._databasePath; }

    get size() {
        this._assertInitialized();
        return this._db.prepare("SELECT COUNT(*) AS count FROM payment_intent").get().count;
    }

    initialize() {

        if (this._initialized) return;
        mkdirSync(this._dataDir, { recursive: true });
        this._db = new Database(this._databasePath, { timeout: this._busyTimeoutMs });
        this._db.pragma(`busy_timeout = ${this._busyTimeoutMs}`);
        this._db.pragma("foreign_keys = ON");
        try {
            const initializeTransaction = this._db.transaction(() => {
                const objects = schemaObjects(this._db);
                if (objects.length === 0) {
                    this._db.exec(`
                        CREATE TABLE payment_intent (
                            paymentReference TEXT NOT NULL PRIMARY KEY,
                            schemaVersion INTEGER NOT NULL,
                            roomId TEXT NOT NULL,
                            playerId TEXT NOT NULL,
                            network TEXT NOT NULL,
                            destinationWalletId TEXT NOT NULL,
                            destinationWalletAddress TEXT NOT NULL,
                            expectedSender TEXT NOT NULL,
                            amountAtomic INTEGER NOT NULL,
                            asset TEXT NOT NULL,
                            createdAt INTEGER NOT NULL,
                            expiresAt INTEGER NOT NULL,
                            roomDeadlineMs INTEGER NOT NULL,
                            state TEXT NOT NULL,
                            transactionId TEXT UNIQUE,
                            updatedAt INTEGER,
                            storage_version INTEGER NOT NULL CHECK (storage_version >= 1)
                        );
                        CREATE INDEX payment_intent_room_idx
                            ON payment_intent(roomId, paymentReference);
                        CREATE TABLE payment_intent_tombstone (
                            paymentReference TEXT NOT NULL PRIMARY KEY,
                            storage_version INTEGER NOT NULL CHECK (storage_version >= 1)
                        );
                        CREATE TABLE payment_intent_metadata (
                            key TEXT NOT NULL PRIMARY KEY,
                            value INTEGER NOT NULL
                        );
                    `);
                    this._db.prepare(
                        "INSERT INTO payment_intent_metadata(key, value) VALUES ('schema_version', ?)"
                    ).run(SQLITE_PAYMENT_INTENT_SCHEMA_VERSION);
                } else {
                    const metadataTable = objects.find((object) => (
                        object.type === "table" && object.name === "payment_intent_metadata"
                    ));
                    if (!metadataTable) {
                        throw schemaError("schema metadata is missing from a non-empty database");
                    }
                    assertExactColumns(this._db, "payment_intent_metadata", METADATA_COLUMNS);
                    const schemaVersion = this._db.prepare(
                        "SELECT value FROM payment_intent_metadata WHERE key = 'schema_version'"
                    ).get()?.value;
                    if (schemaVersion === undefined) {
                        throw schemaError("schema version metadata row is missing");
                    }
                    if (schemaVersion !== SQLITE_PAYMENT_INTENT_SCHEMA_VERSION) {
                        throw new PaymentStorageError(
                            `unsupported SQLite payment schema version: ${schemaVersion}`,
                            { schemaVersion, supportedVersion: SQLITE_PAYMENT_INTENT_SCHEMA_VERSION }
                        );
                    }
                }

                assertPhysicalSchema(this._db);
                for (const row of this._db.prepare("SELECT * FROM payment_intent").all()) {
                    toIntent(row);
                }
            });
            initializeTransaction.immediate();
            this._initialized = true;
            this._logger?.info?.(`SqlitePaymentIntentStore ready | intents=${this.size} | db=${this._databasePath}`);
        } catch (error) {
            this._db.close();
            this._db = null;
            this._initialized = false;
            throw error;
        }

    }

    has(paymentReference) {
        this._assertInitialized();
        return Boolean(this._db.prepare("SELECT 1 FROM payment_intent WHERE paymentReference = ?").get(paymentReference));
    }

    get(paymentReference) {
        this._assertInitialized();
        return toIntent(this._db.prepare("SELECT * FROM payment_intent WHERE paymentReference = ?").get(paymentReference));
    }

    require(paymentReference) {
        const intent = this.get(paymentReference);
        if (!intent) throw new PaymentIntentNotFoundError(paymentReference);
        return intent;
    }

    listForRoom(roomId) {
        this._assertInitialized();
        return this._db.prepare("SELECT * FROM payment_intent WHERE roomId = ? ORDER BY paymentReference")
            .all(roomId).map(toIntent);
    }

    list() {
        this._assertInitialized();
        return this._db.prepare("SELECT * FROM payment_intent ORDER BY paymentReference")
            .all().map(toIntent);
    }

    findByTransactionId(transactionId) {
        this._assertInitialized();
        return toIntent(this._db.prepare("SELECT * FROM payment_intent WHERE transactionId = ?").get(transactionId));
    }

    hasTransactionBeenCredited(transactionId) {
        this._assertInitialized();
        return Boolean(this._db.prepare("SELECT 1 FROM payment_intent WHERE transactionId = ?").get(transactionId));
    }

    listCreditedTransactions() {
        this._assertInitialized();
        return new Map(this._db.prepare(
            "SELECT transactionId, paymentReference FROM payment_intent WHERE transactionId IS NOT NULL ORDER BY transactionId"
        ).all().map((row) => [row.transactionId, row.paymentReference]));
    }

    save(intentOrRecord) {
        this._assertInitialized();
        const intent = intentOrRecord instanceof PaymentIntent
            ? intentOrRecord : PaymentIntent.fromRecord(intentOrRecord);
        assertSupportedBusinessSchemaVersion(intent);
        const insert = this._db.prepare(`INSERT INTO payment_intent (${INSERT_COLUMNS}, storage_version)
            VALUES (${INSERT_VALUES}, @storage_version)`);
        const saveTransaction = this._db.transaction(() => {
            if (this._db.prepare("SELECT 1 FROM payment_intent WHERE paymentReference = ?")
                .get(intent.paymentReference)) {
                throw new PaymentReferenceCollisionError(intent.paymentReference);
            }
            const tombstone = this._db.prepare(
                "SELECT storage_version FROM payment_intent_tombstone WHERE paymentReference = ?"
            ).get(intent.paymentReference);
            insert.run({ ...intent.toRecord(), storage_version: tombstone ? tombstone.storage_version + 1 : 1 });
            return toIntent(this._db.prepare(
                "SELECT * FROM payment_intent WHERE paymentReference = ?"
            ).get(intent.paymentReference));
        });
        try {
            return saveTransaction.immediate();
        } catch (error) {
            if (error instanceof PaymentReferenceCollisionError) throw error;
            if (isUniqueError(error)) {
                if (String(error.message).includes("transactionId")) {
                    throw new TransactionAlreadyCreditedError(intent.transactionId, intent.paymentReference);
                }
                throw new PaymentReferenceCollisionError(intent.paymentReference);
            }
            throw error;
        }
    }

    update(intentOrRecord) {
        this._assertInitialized();
        const next = intentOrRecord instanceof PaymentIntent
            ? intentOrRecord : PaymentIntent.fromRecord(intentOrRecord);
        assertSupportedBusinessSchemaVersion(next);
        const expectedVersion = next.getExpectedStorageVersion();
        if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
            throw new PaymentValidationError("update requires an intent with a valid persisted storage version", {
                paymentReference: next.paymentReference, expectedStorageVersion: expectedVersion
            });
        }

        const updateTransaction = this._db.transaction(() => {
            const row = this._db.prepare("SELECT * FROM payment_intent WHERE paymentReference = ?")
                .get(next.paymentReference);
            if (!row) throw new PaymentIntentNotFoundError(next.paymentReference);
            const existing = readRecord(row);
            const actualVersion = Number(row.storage_version);
            if (actualVersion !== expectedVersion) {
                throw new PaymentIntentStorageConflictError(next.paymentReference, expectedVersion, actualVersion);
            }
            for (const field of IMMUTABLE_FIELDS) {
                if (!Object.is(existing[field], next[field])) {
                    throw new PaymentValidationError(`payment intent immutable field cannot be changed: ${field}`, {
                        paymentReference: next.paymentReference, field
                    });
                }
            }
            if (existing.state !== next.state && !canTransition(existing.state, next.state)) {
                throw new InvalidPaymentStateTransitionError(existing.state, next.state, {
                    paymentReference: next.paymentReference
                });
            }
            if (next.transactionId !== null) {
                const credited = this._db.prepare(
                    "SELECT paymentReference FROM payment_intent WHERE transactionId = ? AND paymentReference <> ?"
                ).get(next.transactionId, next.paymentReference);
                if (credited) throw new TransactionAlreadyCreditedError(next.transactionId, credited.paymentReference);
            }
            const assignments = RECORD_FIELDS.filter((field) => field !== "paymentReference")
                .map((field) => `${field} = @${field}`).join(", ");
            const result = this._db.prepare(`UPDATE payment_intent SET ${assignments}, storage_version = storage_version + 1
                WHERE paymentReference = @paymentReference AND storage_version = @expectedVersion`)
                .run({ ...next.toRecord(), expectedVersion });
            if (result.changes !== 1) {
                const current = this._db.prepare("SELECT storage_version FROM payment_intent WHERE paymentReference = ?")
                    .get(next.paymentReference);
                if (!current) throw new PaymentIntentNotFoundError(next.paymentReference);
                throw new PaymentIntentStorageConflictError(next.paymentReference, expectedVersion, Number(current.storage_version));
            }
            return toIntent(this._db.prepare("SELECT * FROM payment_intent WHERE paymentReference = ?")
                .get(next.paymentReference));
        });
        try {
            return updateTransaction.immediate();
        } catch (error) {
            if (isUniqueError(error)) {
                throw new TransactionAlreadyCreditedError(next.transactionId, next.paymentReference);
            }
            throw error;
        }
    }

    delete(paymentReference) {
        this._assertInitialized();
        const deleteTransaction = this._db.transaction(() => {
            const row = this._db.prepare("SELECT storage_version FROM payment_intent WHERE paymentReference = ?")
                .get(paymentReference);
            if (!row) return false;
            this._db.prepare(`INSERT INTO payment_intent_tombstone(paymentReference, storage_version)
                VALUES (?, ?) ON CONFLICT(paymentReference) DO UPDATE SET
                storage_version = MAX(storage_version, excluded.storage_version)`)
                .run(paymentReference, row.storage_version);
            const result = this._db.prepare("DELETE FROM payment_intent WHERE paymentReference = ? AND storage_version = ?")
                .run(paymentReference, row.storage_version);
            if (result.changes !== 1) throw new PaymentIntentStorageConflictError(paymentReference, row.storage_version, null);
            return true;
        });
        return deleteTransaction.immediate();
    }

    close() {
        if (this._db) this._db.close();
        this._db = null;
        this._initialized = false;
    }

    _assertInitialized() {
        if (!this._initialized) throw new PaymentStorageError("SqlitePaymentIntentStore is not initialized");
    }

}
