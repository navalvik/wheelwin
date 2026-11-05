/**
 * Phase 4 — Immutable, append-only ledger entry.
 *
 * Every entry carries:
 *   - an IMMUTABLE UNIQUE IDENTIFIER (`entryId`), and
 *   - an IDEMPOTENCY KEY (`idempotencyKey`) — a transaction cannot be booked
 *     twice; a colliding key with different identity is rejected.
 *
 * Entries are frozen on construction and are NEVER mutated or deleted. Status
 * changes (e.g. a payout reservation becoming settled) are represented by
 * APPENDING a new entry that references the previous one, so the journal is
 * append-only and protected from silent overwrites.
 *
 * All amounts are integer atomic units (nanotons). No floating point.
 */

import { randomBytes } from "node:crypto";

import {
    LEDGER_ENTRY_KIND,
    LEDGER_ENTRY_KINDS,
    LEDGER_ENTRY_SCHEMA_VERSION,
    isLedgerEntryKind
} from "./LedgerConstants.js";

import { LedgerEntryError } from "./LedgerErrors.js";

/**
 * @param {unknown} value
 * @returns {asserts value is string}
 */
function assertNonEmptyString(value, field) {

    if (typeof value !== "string" || value.trim() === "") {

        throw new LedgerEntryError(
            `${field} must be a non-empty string`,
            { field, value }
        );

    }

}

/**
 * A positive integer atomic-unit amount. No floating point is accepted.
 *
 * @param {unknown} value
 * @returns {asserts value is number}
 */
function assertAtomicAmount(value, field = "amountAtomic") {

    if (typeof value !== "number"
        || !Number.isSafeInteger(value)
        || value <= 0) {

        throw new LedgerEntryError(
            `${field} must be a positive safe integer (atomic units)`,
            { [field]: value }
        );

    }

}

/**
 * Generate an immutable, unique entry identifier.
 *
 * @returns {string}
 */
export function generateLedgerEntryId() {

    return `ledg_${randomBytes(12).toString("hex")}`;

}

export class LedgerEntry {

    /**
     * @param {{
     *   entryId?: string,
     *   idempotencyKey: string,
     *   roomId: string,
     *   kind: string,
     *   amountAtomic: number,
     *   playerId?: string|null,
     *   asset?: string,
     *   network: string,
     *   metadata?: object,
     *   createdAtMs: number,
     *   sequence: number,
     *   schemaVersion?: number
     * }} record
     */
    constructor(record) {

        if (!record || typeof record !== "object") {

            throw new LedgerEntryError("ledger entry record must be a non-null object");

        }

        const entryId = record.entryId ?? generateLedgerEntryId();

        assertNonEmptyString(entryId, "entryId");
        assertNonEmptyString(record.idempotencyKey, "idempotencyKey");
        assertNonEmptyString(record.roomId, "roomId");
        assertNonEmptyString(record.network, "network");

        if (!isLedgerEntryKind(record.kind)) {

            throw new LedgerEntryError(
                `unknown ledger entry kind: ${record.kind}`,
                { kind: record.kind, known: LEDGER_ENTRY_KINDS }
            );

        }

        assertAtomicAmount(record.amountAtomic, "amountAtomic");

        if (record.asset !== undefined) {

            assertNonEmptyString(record.asset, "asset");

        }

        if (!Number.isInteger(record.createdAtMs) || record.createdAtMs <= 0) {

            throw new LedgerEntryError(
                "createdAtMs must be a positive integer epoch-milliseconds value",
                { createdAtMs: record.createdAtMs }
            );

        }

        if (!Number.isInteger(record.sequence) || record.sequence < 0) {

            throw new LedgerEntryError(
                "sequence must be a non-negative integer",
                { sequence: record.sequence }
            );

        }

        this.entryId = entryId;

        this.idempotencyKey = record.idempotencyKey;

        this.roomId = record.roomId;

        this.kind = record.kind;

        this.amountAtomic = record.amountAtomic;

        this.playerId = record.playerId ?? null;

        this.asset = record.asset ?? null;

        this.network = record.network;

        this.metadata = Object.freeze({ ...(record.metadata ?? {}) });

        this.createdAtMs = record.createdAtMs;

        this.sequence = record.sequence;

        this.schemaVersion = record.schemaVersion ?? LEDGER_ENTRY_SCHEMA_VERSION;

        Object.freeze(this);

    }

    /**
     * Serialized durable-storage payload (also the JSON on disk).
     */
    toRecord() {

        return Object.freeze({
            schemaVersion: this.schemaVersion,
            entryId: this.entryId,
            idempotencyKey: this.idempotencyKey,
            roomId: this.roomId,
            kind: this.kind,
            amountAtomic: this.amountAtomic,
            playerId: this.playerId,
            asset: this.asset,
            network: this.network,
            metadata: this.metadata,
            createdAtMs: this.createdAtMs,
            sequence: this.sequence
        });

    }

    /**
     * Rebuild a frozen entry from a persisted record with full validation
     * (fail closed).
     *
     * @param {object} record
     * @returns {LedgerEntry}
     */
    static fromRecord(record) {

        return new LedgerEntry(record);

    }

}

export { assertAtomicAmount, isLedgerEntryKind, LEDGER_ENTRY_KIND };
