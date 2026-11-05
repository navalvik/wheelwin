import { durableWriteJson } from '../DurableJson.js';
/**
 * Phase 4 — Durable, append-only internal ledger store.
 *
 * Convention: file-backed JSON under `<dataDir>/ledger/entries/<entryId>.json`
 * with atomic temp-file + rename writes (matching the existing server storage
 * convention used by the Phase 1 PaymentIntentStore). It is deliberately NOT an
 * in-memory-only ledger.
 *
 * Guarantees:
 *   - append-only: entries are never mutated or deleted (see `LedgerEntry`);
 *   - idempotency: appending an entry whose idempotency key was already booked
 *     is a REPLAY no-op — a transaction can never be booked twice;
 *   - overwrite protection: on load, two persisted entries that claim the same
 *     idempotency key with different identities, or the same entry id, are
 *     rejected (fail closed) instead of being silently overwritten;
 *   - restart-safe: the full journal is reloaded and re-indexed on
 *     `initialize()`.
 *
 * This store never sends, broadcasts, signs, deploys, reads a provider, or
 * touches wallet secrets.
 */

import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    unlinkSync,
    writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";

import {
    LEDGER_ENTRY_SCHEMA_VERSION,
    LEDGER_ENTRY_KIND
} from "./LedgerConstants.js";

import { LedgerEntry } from "./LedgerEntry.js";

import {
    CorruptedLedgerRecordError,
    LedgerReplayError,
    LedgerStorageError
} from "./LedgerErrors.js";

/**
 * Atomic durable write (temp file + rename).
 *
 * @param {string} filePath
 * @param {object} payload
 */
function atomicWriteJson(filePath, payload) { durableWriteJson(filePath, payload); }

/**
 * @param {string} filePath
 * @returns {string}
 */
function fileNameOf(filePath) {

    const index = filePath.lastIndexOf("\\");

    const slash = filePath.lastIndexOf("/");

    return filePath.slice(Math.max(index, slash) + 1);

}

export class LedgerStore {

    constructor({
        dataDir,
        logger = null,
        nowProvider = Date.now
    } = {}) {

        if (typeof dataDir !== "string" || dataDir.trim() === "") {

            throw new LedgerStorageError("dataDir must be a non-empty string");

        }

        this._dataDir = dataDir;

        this._logger = logger;

        this._now = nowProvider;

        this._entriesDir = join(dataDir, "ledger", "entries");

        /** @type {Map<string, LedgerEntry>} key = entryId */
        this._byEntryId = new Map();

        /** @type {Map<string, string>} idempotencyKey -> entryId (replay guard) */
        this._idempotencyIndex = new Map();

        /** @type {Map<string, Set<string>>} roomId -> Set<entryId> */
        this._byRoom = new Map();

        this._nextSequence = 0;

        this._initialized = false;

    }

    get dataDir() {

        return this._dataDir;

    }

    get entriesDir() {

        return this._entriesDir;

    }

    get size() {

        return this._byEntryId.size;

    }

    /**
     * Create the storage directory and rebuild all indexes from disk.
     */
    initialize() {

        mkdirSync(this._entriesDir, { recursive: true });

        this._byEntryId.clear();

        this._idempotencyIndex.clear();

        this._byRoom.clear();

        let maxSequence = -1;

        for (const fileName of readdirSync(this._entriesDir)) {

            if (!fileName.endsWith(".json")) {

                continue;

            }

            const entry = this._loadFromDisk(join(this._entriesDir, fileName));

            this._indexEntry(entry);

            if (entry.sequence > maxSequence) {

                maxSequence = entry.sequence;

            }

        }

        this._nextSequence = maxSequence + 1;

        this._initialized = true;

        this._logInfo(
            `LedgerStore ready | entries=${this._byEntryId.size}`
                + ` | dir=${this._entriesDir}`
        );

    }

    _loadFromDisk(filePath) {

        const baseName = fileNameOf(filePath);

        let parsed;

        try {

            parsed = JSON.parse(readFileSync(filePath, "utf8"));

        } catch (error) {

            throw new CorruptedLedgerRecordError(
                baseName,
                `unreadable json | ${error?.message ?? error}`
            );

        }

        if (parsed?.schemaVersion !== LEDGER_ENTRY_SCHEMA_VERSION) {

            throw new CorruptedLedgerRecordError(
                baseName,
                `unsupported schemaVersion ${parsed?.schemaVersion}`
            );

        }

        let entry;

        try {

            entry = LedgerEntry.fromRecord(parsed);

        } catch (error) {

            throw new CorruptedLedgerRecordError(
                baseName,
                `invalid entry | ${error?.message ?? error}`
            );

        }

        if (baseName !== `${entry.entryId}.json`) {

            throw new CorruptedLedgerRecordError(
                baseName,
                "file name does not match the persisted entry id"
            );

        }

        // Overwrite protection: two entries sharing an entry id on disk.
        if (this._byEntryId.has(entry.entryId)) {

            throw new CorruptedLedgerRecordError(
                baseName,
                "duplicate entry id in the persisted ledger"
            );

        }

        // Overwrite protection: one idempotency key booked to two entries.
        const existingId = this._idempotencyIndex.get(entry.idempotencyKey);

        if (existingId && existingId !== entry.entryId) {

            throw new LedgerReplayError(entry.idempotencyKey, {
                conflictWith: existingId,
                entryId: entry.entryId
            });

        }

        return entry;

    }

    _indexEntry(entry) {

        this._byEntryId.set(entry.entryId, entry);

        this._idempotencyIndex.set(entry.idempotencyKey, entry.entryId);

        let roomSet = this._byRoom.get(entry.roomId);

        if (!roomSet) {

            roomSet = new Set();

            this._byRoom.set(entry.roomId, roomSet);

        }

        roomSet.add(entry.entryId);

    }

    // -------------------------------------------------------------------------
    // Identity lookups
    // -------------------------------------------------------------------------

    /**
     * @param {string} entryId
     * @returns {boolean}
     */
    hasEntry(entryId) {

        return this._byEntryId.has(entryId);

    }

    /**
     * @param {string} entryId
     * @returns {LedgerEntry|null}
     */
    getEntry(entryId) {

        return this._byEntryId.get(entryId) ?? null;

    }

    /**
     * Whether the idempotency key has already been booked (replay guard).
     *
     * @param {string} idempotencyKey
     * @returns {boolean}
     */
    hasIdempotencyKey(idempotencyKey) {

        return this._idempotencyIndex.has(idempotencyKey);

    }

    /**
     * The entry an idempotency key was booked to, or null.
     *
     * @param {string} idempotencyKey
     * @returns {LedgerEntry|null}
     */
    findByIdempotencyKey(idempotencyKey) {

        const entryId = this._idempotencyIndex.get(idempotencyKey);

        return entryId ? this._byEntryId.get(entryId) ?? null : null;

    }

    /**
     * @param {string} roomId
     * @returns {LedgerEntry[]} entries in journal (sequence) order.
     */
    listForRoom(roomId) {

        const ids = this._byRoom.get(roomId);

        if (!ids) {

            return [];

        }

        return [...ids]
            .map((entryId) => this._byEntryId.get(entryId))
            .filter((entry) => entry !== undefined)
            .sort((a, b) => a.sequence - b.sequence);

    }

    /**
     * @returns {LedgerEntry[]} every entry in journal (sequence) order.
     */
    list() {

        return [...this._byEntryId.values()].sort((a, b) => a.sequence - b.sequence);

    }

    // -------------------------------------------------------------------------
    // Append (idempotent, append-only)
    // -------------------------------------------------------------------------

    /**
     * Append a new entry. Idempotent by `idempotencyKey`:
     *   - replaying an already-booked key returns the existing entry with
     *     `replay: true` and writes nothing (a transaction cannot be booked
     *     twice);
     *   - a genuinely new key appends and persists a new immutable entry.
     *
     * @param {object} descriptor
     * @returns {{ replay: boolean, entry: LedgerEntry }}
     */
    append(descriptor) {

        this._assertInitialized();

        if (!descriptor || typeof descriptor !== "object") {

            throw new LedgerStorageError("append requires a descriptor object");

        }

        const existing = this.findByIdempotencyKey(descriptor.idempotencyKey);

        if (existing) {

            // Idempotent replay — never booked twice.
            return { replay: true, entry: existing };

        }

        const entry = new LedgerEntry({
            ...descriptor,
            entryId: descriptor.entryId ?? undefined,
            sequence: this._nextSequence,
            createdAtMs: descriptor.createdAtMs ?? this._now()
        });

        // Defensive: a freshly generated entry id colliding is astronomically
        // unlikely, but a collision is never silently overwritten.
        if (this._byEntryId.has(entry.entryId)) {

            throw new LedgerReplayError(entry.idempotencyKey, {
                entryId: entry.entryId
            });

        }

        this._writeToDisk(entry);

        this._indexEntry(entry);

        this._nextSequence += 1;

        return { replay: false, entry };

    }

    /**
     * Internal-only escape hatch for tests / recovery that must remove a whole
     * entry file. Ordinary accounting NEVER calls this: the journal is
     * append-only. Present so the durable layer remains operable; it is not
     * exposed on the RoomLedger accounting surface.
     *
     * @param {string} entryId
     * @returns {boolean}
     */
    forget(entryId) {

        this._assertInitialized();

        const entry = this._byEntryId.get(entryId);

        if (!entry) {

            return false;

        }

        const filePath = this._entryPath(entryId);

        if (existsSync(filePath)) {

            try {

                unlinkSync(filePath);

            } catch (error) {

                throw new LedgerStorageError(
                    `failed to delete ledger entry file: ${error?.message ?? error}`,
                    { entryId }
                );

            }

        }

        this._byEntryId.delete(entryId);

        this._idempotencyIndex.delete(entry.idempotencyKey);

        const roomSet = this._byRoom.get(entry.roomId);

        roomSet?.delete(entryId);

        return true;

    }

    _writeToDisk(entry) {

        try {

            atomicWriteJson(this._entryPath(entry.entryId), entry.toRecord());

        } catch (error) {

            throw new LedgerStorageError(
                `failed to persist ledger entry: ${error?.message ?? error}`,
                { entryId: entry.entryId, idempotencyKey: entry.idempotencyKey }
            );

        }

    }

    _entryPath(entryId) {

        return join(this._entriesDir, `${entryId}.json`);

    }

    _assertInitialized() {

        if (!this._initialized) {

            throw new LedgerStorageError("LedgerStore is not initialized");

        }

    }

    _logInfo(message) {

        this._logger?.info?.(message);

    }

}

export { atomicWriteJson, LEDGER_ENTRY_KIND };
