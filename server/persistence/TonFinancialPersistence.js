/**
 * T2.1 — Authoritative durable storage for WheelWin financial state.
 *
 * Passive persistence only. No business logic, blockchain, gameplay, or EventBus.
 * Managers call this layer to survive server restart and support recovery.
 */

import {
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    unlinkSync,
    writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";

import {
    CorruptedRecordError,
    DuplicateRecordError,
    ImmutableRecordError,
    IntegrityFailureError,
    RecordNotFoundError,
    RecoveryFailureError,
    StorageUnavailableError,
    VersionMismatchError
} from "./TonFinancialPersistenceErrors.js";
import {
    DELETABLE_RECORD_TYPES,
    RECORD_STORAGE_CATEGORY,
    TON_FINANCIAL_RECORD_TYPES,
    TON_FINANCIAL_SCHEMA_VERSION
} from "./TonFinancialRecordTypes.js";
import {
    buildRecordEnvelope,
    cloneEnvelopeForUpdate,
    resolveRecordId,
    validateRecordEnvelope
} from "./tonFinancialRecordUtils.js";

const CATEGORY_DIRECTORIES = Object.freeze({
    active: "active",
    immutable: "immutable",
    archived: "archived"
});

/**
 * @typedef {object} TonFinancialPersistenceOptions
 * @property {object} [logger]
 * @property {string} [dataDir]
 * @property {boolean} [autoCheckpoint]
 */

export class TonFinancialPersistence {

    constructor({
        logger = null,
        dataDir = null,
        autoCheckpoint = true
    } = {}) {

        this._logger = logger;

        this._dataDir = dataDir;

        this._autoCheckpoint = autoCheckpoint === true;

        this._initialized = false;

        this._manifest = null;

        /** @type {Map<string, object>} */
        this._records = new Map();

        this._indexes = {
            byRoom: new Map(),
            byGame: new Map(),
            byContract: new Map()
        };

    }

    initialize({ dataDir = null } = {}) {

        if (dataDir) {

            this._dataDir = dataDir;

        }

        if (!this._dataDir) {

            throw new StorageUnavailableError("TonFinancialPersistence dataDir is required");

        }

        this._ensureStorageLayout();

        this._manifest = this._loadManifest();

        const restoreSummary = this.restore();

        this._initialized = true;

        this._logInfo(
            `TonFinancialPersistence initialized | dataDir=${this._dataDir} | `
                + `records=${restoreSummary.recordCount}`
        );

        return restoreSummary;

    }

    shutdown({ checkpoint = true } = {}) {

        if (checkpoint && this._initialized) {

            this.checkpoint({ reason: "shutdown" });

        }

        this._initialized = false;

    }

    // -------------------------------------------------------------------------
    // Generic API
    // -------------------------------------------------------------------------

    create(recordType, payload, metadata = {}) {

        this._assertReady();

        const recordId = resolveRecordId(recordType, payload, metadata);

        if (!recordId) {

            throw new StorageUnavailableError(
                `Unable to resolve record id | type=${recordType}`
            );

        }

        const key = this._recordKey(recordType, recordId);

        if (this._records.has(key)) {

            throw new DuplicateRecordError(recordType, recordId);

        }

        const envelope = buildRecordEnvelope({
            recordType,
            recordId,
            payload,
            metadata
        });

        this._writeRecord(envelope);

        this._records.set(key, envelope);

        this._indexRecord(envelope);

        this._maybeCheckpoint("create", recordType, recordId);

        return this._publicRecord(envelope);

    }

    load(recordType, recordId) {

        this._assertReady();

        const envelope = this._getRecord(recordType, recordId);

        return this._publicRecord(envelope);

    }

    update(recordType, recordId, payload, metadata = {}) {

        this._assertReady();

        const existing = this._getRecord(recordType, recordId);

        if (existing.immutable) {

            throw new ImmutableRecordError(recordType, recordId);

        }

        if (
            metadata.expectedVersion != null
            && existing.version !== metadata.expectedVersion
        ) {

            throw new VersionMismatchError(
                recordType,
                recordId,
                metadata.expectedVersion,
                existing.version
            );

        }

        const next = cloneEnvelopeForUpdate(existing, {
            payload,
            metadata: {
                ...metadata,
                version: existing.version
            }
        });

        this._writeRecord(next);

        this._records.set(this._recordKey(recordType, recordId), next);

        this._indexRecord(next);

        this._maybeCheckpoint("update", recordType, recordId);

        return this._publicRecord(next);

    }

    deleteRecord(recordType, recordId) {

        this._assertReady();

        if (!DELETABLE_RECORD_TYPES.includes(recordType)) {

            throw new ImmutableRecordError(recordType, recordId);

        }

        const key = this._recordKey(recordType, recordId);

        if (!this._records.has(key)) {

            throw new RecordNotFoundError(recordType, recordId);

        }

        const filePath = this._recordPath(recordType, recordId);

        this._safeUnlink(filePath);

        this._unindexRecord(this._records.get(key));

        this._records.delete(key);

        this._maybeCheckpoint("delete", recordType, recordId);

        return true;

    }

    archive(contractId, metadata = {}) {

        this._assertReady();

        const contract = this._getRecord(
            TON_FINANCIAL_RECORD_TYPES.GAME_CONTRACT,
            contractId
        );

        const archivedPayload = Object.freeze({
            ...contract.payload,
            archivedAt: metadata.archivedAt ?? Date.now(),
            archiveReason: metadata.archiveReason ?? "archived"
        });

        const archived = this.create(
            TON_FINANCIAL_RECORD_TYPES.ARCHIVED_CONTRACT,
            archivedPayload,
            {
                ...metadata,
                contractId,
                roomId: contract.roomId,
                gameId: contract.gameId,
                tonNetwork: contract.tonNetwork,
                correlationId: metadata.correlationId ?? contract.correlationId,
                status: "ARCHIVED"
            }
        );

        const activeKey = this._recordKey(
            TON_FINANCIAL_RECORD_TYPES.GAME_CONTRACT,
            contractId
        );

        this._safeUnlink(this._recordPath(
            TON_FINANCIAL_RECORD_TYPES.GAME_CONTRACT,
            contractId
        ));

        this._unindexRecord(this._records.get(activeKey));

        this._records.delete(activeKey);

        this._maybeCheckpoint("archive", TON_FINANCIAL_RECORD_TYPES.ARCHIVED_CONTRACT, contractId);

        return archived;

    }

    restore() {

        this._records.clear();

        this._indexes.byRoom.clear();

        this._indexes.byGame.clear();

        this._indexes.byContract.clear();

        const errors = [];

        let recordCount = 0;

        for (const recordType of Object.values(TON_FINANCIAL_RECORD_TYPES)) {

            const dir = this._typeDirectory(recordType);

            if (!dir) {

                continue;

            }

            let files = [];

            try {

                files = readdirSync(dir).filter((name) => name.endsWith(".json"));

            } catch (error) {

                if (error?.code !== "ENOENT") {

                    errors.push({
                        recordType,
                        reason: error?.message ?? "read_dir_failed"
                    });

                }

                continue;

            }

            for (const fileName of files) {

                const filePath = join(dir, fileName);

                try {

                    const envelope = this._readEnvelopeFile(filePath);

                    const validationErrors = validateRecordEnvelope(envelope);

                    if (validationErrors.length > 0) {

                        throw new CorruptedRecordError(
                            envelope.recordType,
                            envelope.recordId,
                            validationErrors.join(",")
                        );

                    }

                    const key = this._recordKey(envelope.recordType, envelope.recordId);

                    this._records.set(key, envelope);

                    this._indexRecord(envelope);

                    recordCount += 1;

                } catch (error) {

                    if (error instanceof CorruptedRecordError) {

                        throw error;

                    }

                    errors.push({
                        filePath,
                        reason: error?.message ?? "restore_failed"
                    });

                }

            }

        }

        if (errors.length > 0) {

            const summary = Object.freeze({
                recordCount,
                errors: Object.freeze(errors)
            });

            this._logError(
                `TonFinancialPersistence restore completed with errors | count=${errors.length}`
            );

            if (recordCount === 0) {

                throw new RecoveryFailureError(
                    "TonFinancialPersistence restore failed",
                    summary
                );

            }

            return summary;

        }

        return Object.freeze({
            recordCount,
            errors: Object.freeze([])
        });

    }

    checkpoint({ reason = "manual" } = {}) {

        this._assertReady();

        const manifest = Object.freeze({
            schemaVersion: TON_FINANCIAL_SCHEMA_VERSION,
            checkpointAt: Date.now(),
            reason,
            recordCount: this._records.size,
            indexes: Object.freeze({
                rooms: this._indexes.byRoom.size,
                games: this._indexes.byGame.size,
                contracts: this._indexes.byContract.size
            })
        });

        this._writeJsonAtomic(this._manifestPath(), manifest);

        this._manifest = manifest;

        this._logInfo(
            `TonFinancialPersistence checkpoint | reason=${reason} | `
                + `records=${manifest.recordCount}`
        );

        return manifest;

    }

    integrityCheck() {

        this._assertReady();

        const errors = [];

        for (const envelope of this._records.values()) {

            const validationErrors = validateRecordEnvelope(envelope);

            if (validationErrors.length > 0) {

                errors.push({
                    recordType: envelope.recordType,
                    recordId: envelope.recordId,
                    errors: validationErrors
                });

            }

            const filePath = this._recordPath(envelope.recordType, envelope.recordId);

            try {

                const fromDisk = this._readEnvelopeFile(filePath);

                const diskErrors = validateRecordEnvelope(fromDisk);

                if (diskErrors.length > 0) {

                    errors.push({
                        recordType: envelope.recordType,
                        recordId: envelope.recordId,
                        errors: diskErrors,
                        source: "disk"
                    });

                }

            } catch (error) {

                errors.push({
                    recordType: envelope.recordType,
                    recordId: envelope.recordId,
                    errors: [error?.message ?? "disk_read_failed"],
                    source: "disk"
                });

            }

        }

        const report = Object.freeze({
            ok: errors.length === 0,
            checkedAt: Date.now(),
            recordCount: this._records.size,
            errors: Object.freeze(errors)
        });

        if (!report.ok) {

            this._logError(
                `TonFinancialPersistence integrity check failed | errors=${errors.length}`
            );

        }

        return report;

    }

    listActive(recordType = null) {

        this._assertReady();

        return this._listRecords((envelope) => {

            if (recordType && envelope.recordType !== recordType) {

                return false;

            }

            return RECORD_STORAGE_CATEGORY[envelope.recordType] === "active";

        });

    }

    listArchived() {

        this._assertReady();

        return this._listRecords(
            (envelope) => envelope.recordType === TON_FINANCIAL_RECORD_TYPES.ARCHIVED_CONTRACT
        );

    }

    findByRoom(roomId) {

        this._assertReady();

        return this._findByIndex(this._indexes.byRoom, roomId);

    }

    findByGame(gameId) {

        this._assertReady();

        return this._findByIndex(this._indexes.byGame, gameId);

    }

    findByContract(contractId) {

        this._assertReady();

        return this._findByIndex(this._indexes.byContract, contractId);

    }

    // -------------------------------------------------------------------------
    // Typed convenience API
    // -------------------------------------------------------------------------

    createGameContract(payload, metadata = {}) {

        return this.create(TON_FINANCIAL_RECORD_TYPES.GAME_CONTRACT, payload, metadata);

    }

    updateGameContract(contractId, payload, metadata = {}) {

        return this.update(
            TON_FINANCIAL_RECORD_TYPES.GAME_CONTRACT,
            contractId,
            payload,
            metadata
        );

    }

    loadGameContract(contractId) {

        return this.load(TON_FINANCIAL_RECORD_TYPES.GAME_CONTRACT, contractId);

    }

    createPaymentSession(payload, metadata = {}) {

        return this.create(TON_FINANCIAL_RECORD_TYPES.PAYMENT_SESSION, payload, metadata);

    }

    updatePaymentSession(paymentSessionId, payload, metadata = {}) {

        return this.update(
            TON_FINANCIAL_RECORD_TYPES.PAYMENT_SESSION,
            paymentSessionId,
            payload,
            metadata
        );

    }

    loadPaymentSession(paymentSessionId) {

        return this.load(TON_FINANCIAL_RECORD_TYPES.PAYMENT_SESSION, paymentSessionId);

    }

    createWalletSession(payload, metadata = {}) {

        return this.create(TON_FINANCIAL_RECORD_TYPES.WALLET_SESSION, payload, metadata);

    }

    updateWalletSession(roomId, payload, metadata = {}) {

        return this.update(
            TON_FINANCIAL_RECORD_TYPES.WALLET_SESSION,
            roomId,
            payload,
            metadata
        );

    }

    loadWalletSession(roomId) {

        return this.load(TON_FINANCIAL_RECORD_TYPES.WALLET_SESSION, roomId);

    }

    createSettlementRecord(payload, metadata = {}) {

        return this.create(TON_FINANCIAL_RECORD_TYPES.SETTLEMENT, payload, metadata);

    }

    updateSettlementRecord(gameId, payload, metadata = {}) {

        return this.update(
            TON_FINANCIAL_RECORD_TYPES.SETTLEMENT,
            gameId,
            payload,
            metadata
        );

    }

    loadSettlementRecord(gameId) {

        return this.load(TON_FINANCIAL_RECORD_TYPES.SETTLEMENT, gameId);

    }

    createSnapshotRecord(payload, metadata = {}) {

        return this.create(TON_FINANCIAL_RECORD_TYPES.SNAPSHOT, payload, metadata);

    }

    loadSnapshotRecord(snapshotId) {

        return this.load(TON_FINANCIAL_RECORD_TYPES.SNAPSHOT, snapshotId);

    }

    createAuditRecord(payload, metadata = {}) {

        return this.create(TON_FINANCIAL_RECORD_TYPES.AUDIT, payload, metadata);

    }

    loadAuditRecord(auditId) {

        return this.load(TON_FINANCIAL_RECORD_TYPES.AUDIT, auditId);

    }

    createRecoveryCheckpoint(payload, metadata = {}) {

        return this.create(
            TON_FINANCIAL_RECORD_TYPES.RECOVERY_CHECKPOINT,
            payload,
            metadata
        );

    }

    loadRecoveryCheckpoint(checkpointId) {

        return this.load(
            TON_FINANCIAL_RECORD_TYPES.RECOVERY_CHECKPOINT,
            checkpointId
        );

    }

    deleteRecoveryCheckpoint(checkpointId) {

        return this.deleteRecord(
            TON_FINANCIAL_RECORD_TYPES.RECOVERY_CHECKPOINT,
            checkpointId
        );

    }

    loadArchivedContract(contractId) {

        return this.load(TON_FINANCIAL_RECORD_TYPES.ARCHIVED_CONTRACT, contractId);

    }

    // -------------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------------

    _assertReady() {

        if (!this._initialized) {

            throw new StorageUnavailableError("TonFinancialPersistence is not initialized");

        }

    }

    _recordKey(recordType, recordId) {

        return `${recordType}:${recordId}`;

    }

    _categoryForType(recordType) {

        return RECORD_STORAGE_CATEGORY[recordType] ?? "active";

    }

    _typeDirectory(recordType) {

        const category = this._categoryForType(recordType);

        if (!category) {

            return null;

        }

        return join(this._dataDir, CATEGORY_DIRECTORIES[category], recordType);

    }

    _recordPath(recordType, recordId) {

        return join(this._typeDirectory(recordType), `${recordId}.json`);

    }

    _manifestPath() {

        return join(this._dataDir, "manifest.json");

    }

    _ensureStorageLayout() {

        try {

            mkdirSync(this._dataDir, { recursive: true });

            for (const category of Object.values(CATEGORY_DIRECTORIES)) {

                mkdirSync(join(this._dataDir, category), { recursive: true });

            }

            for (const recordType of Object.values(TON_FINANCIAL_RECORD_TYPES)) {

                const dir = this._typeDirectory(recordType);

                if (dir) {

                    mkdirSync(dir, { recursive: true });

                }

            }

        } catch (error) {

            throw new StorageUnavailableError(
                "Unable to initialize TonFinancialPersistence storage layout",
                error
            );

        }

    }

    _loadManifest() {

        const path = this._manifestPath();

        try {

            const raw = readFileSync(path, "utf8");

            return JSON.parse(raw);

        } catch (error) {

            if (error?.code === "ENOENT") {

                return null;

            }

            throw new CorruptedRecordError("manifest", "manifest", error?.message ?? "parse_failed");

        }

    }

    _writeRecord(envelope) {

        const filePath = this._recordPath(envelope.recordType, envelope.recordId);

        this._writeJsonAtomic(filePath, envelope);

    }

    _writeJsonAtomic(filePath, value) {

        try {

            mkdirSync(dirname(filePath), { recursive: true });

            const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;

            writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");

            renameSync(tempPath, filePath);

        } catch (error) {

            throw new StorageUnavailableError(
                `Unable to write persistence record | path=${filePath}`,
                error
            );

        }

    }

    _readEnvelopeFile(filePath) {

        let raw = "";

        try {

            raw = readFileSync(filePath, "utf8");

        } catch (error) {

            throw new CorruptedRecordError("unknown", filePath, error?.message ?? "read_failed");

        }

        try {

            return JSON.parse(raw);

        } catch (error) {

            throw new CorruptedRecordError("unknown", filePath, error?.message ?? "parse_failed");

        }

    }

    _getRecord(recordType, recordId) {

        const key = this._recordKey(recordType, recordId);

        const envelope = this._records.get(key);

        if (!envelope) {

            throw new RecordNotFoundError(recordType, recordId);

        }

        return envelope;

    }

    _indexRecord(envelope) {

        this._addIndexEntry(this._indexes.byRoom, envelope.roomId, envelope);

        this._addIndexEntry(this._indexes.byGame, envelope.gameId, envelope);

        this._addIndexEntry(this._indexes.byContract, envelope.contractId, envelope);

    }

    _unindexRecord(envelope) {

        if (!envelope) {

            return;

        }

        this._removeIndexEntry(this._indexes.byRoom, envelope.roomId, envelope);

        this._removeIndexEntry(this._indexes.byGame, envelope.gameId, envelope);

        this._removeIndexEntry(this._indexes.byContract, envelope.contractId, envelope);

    }

    _addIndexEntry(index, key, envelope) {

        if (!key) {

            return;

        }

        let bucket = index.get(key);

        if (!bucket) {

            bucket = new Map();

            index.set(key, bucket);

        }

        bucket.set(this._recordKey(envelope.recordType, envelope.recordId), envelope);

    }

    _removeIndexEntry(index, key, envelope) {

        if (!key) {

            return;

        }

        const bucket = index.get(key);

        if (!bucket) {

            return;

        }

        bucket.delete(this._recordKey(envelope.recordType, envelope.recordId));

        if (bucket.size === 0) {

            index.delete(key);

        }

    }

    _findByIndex(index, key) {

        const bucket = index.get(key);

        if (!bucket) {

            return Object.freeze([]);

        }

        return Object.freeze(
            [...bucket.values()].map((envelope) => this._publicRecord(envelope))
        );

    }

    _listRecords(predicate) {

        return Object.freeze(
            [...this._records.values()]
                .filter(predicate)
                .map((envelope) => this._publicRecord(envelope))
        );

    }

    _publicRecord(envelope) {

        return Object.freeze({
            recordType: envelope.recordType,
            recordId: envelope.recordId,
            createdAt: envelope.createdAt,
            updatedAt: envelope.updatedAt,
            version: envelope.version,
            status: envelope.status,
            correlationId: envelope.correlationId,
            roomId: envelope.roomId,
            gameId: envelope.gameId,
            contractId: envelope.contractId,
            tonNetwork: envelope.tonNetwork,
            immutable: envelope.immutable,
            checksum: envelope.checksum,
            payload: Object.freeze({ ...envelope.payload })
        });

    }

    _safeUnlink(filePath) {

        try {

            unlinkSync(filePath);

        } catch (error) {

            if (error?.code !== "ENOENT") {

                throw new StorageUnavailableError(
                    `Unable to delete persistence record | path=${filePath}`,
                    error
                );

            }

        }

    }

    _maybeCheckpoint(reason, recordType, recordId) {

        if (!this._autoCheckpoint) {

            return;

        }

        this.checkpoint({
            reason: `${reason}:${recordType}:${recordId}`
        });

    }

    _logInfo(message) {

        this._logger?.info?.(message);

    }

    _logError(message) {

        this._logger?.error?.(message);

    }

    /**
     * Test helper — removes storage directory.
     * @param {string} dataDir
     */
    static destroyStorage(dataDir) {

        rmSync(dataDir, { recursive: true, force: true });

    }

}

export {
    TON_FINANCIAL_RECORD_TYPES,
    TON_FINANCIAL_SCHEMA_VERSION
} from "./TonFinancialRecordTypes.js";

export {
    TonFinancialPersistenceError,
    RecordNotFoundError,
    VersionMismatchError,
    IntegrityFailureError,
    DuplicateRecordError,
    CorruptedRecordError,
    ImmutableRecordError,
    RecoveryFailureError,
    StorageUnavailableError
} from "./TonFinancialPersistenceErrors.js";
