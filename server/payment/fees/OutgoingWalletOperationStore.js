/**
 * Durable journal for server-created outgoing wallet operations.
 *
 * This module is deliberately not a signer or broadcaster. It stores only
 * operation metadata and state transitions; never persist mnemonics, private
 * keys, signed BOCs, or API secrets here.
 *
 * IMPORTANT: this file-backed store is safe only within a single Node process.
 * Atomic rename protects against partial files, not concurrent writers across
 * Railway replicas/hosts. Do not use it to authorize live transfers until
 * replaced by a transactional shared store with uniqueness/locking guarantees.
 */
import { dirname, join } from "node:path";
import { mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tonAddressIdentitiesEqual, tonAddressIdentityOrNull } from "../incoming/TonAddressIdentity.js";

const SCHEMA_VERSION = 1;
export const OUTGOING_WALLET_OPERATION_STATE = Object.freeze({
    PREPARED: "PREPARED",
    SEQNO_RESERVED: "SEQNO_RESERVED",
    SUBMISSION_UNKNOWN: "SUBMISSION_UNKNOWN",
    SUBMITTED: "SUBMITTED",
    FINALIZED: "FINALIZED",
    FAILED_PRE_BROADCAST: "FAILED_PRE_BROADCAST",
    RECONCILIATION_REQUIRED: "RECONCILIATION_REQUIRED"
});
const ALLOWED_TRANSITIONS = Object.freeze({
    PREPARED: new Set(["SEQNO_RESERVED", "FAILED_PRE_BROADCAST", "RECONCILIATION_REQUIRED"]),
    SEQNO_RESERVED: new Set(["SUBMISSION_UNKNOWN", "SUBMITTED", "FAILED_PRE_BROADCAST", "RECONCILIATION_REQUIRED"]),
    SUBMISSION_UNKNOWN: new Set(["SUBMITTED", "FINALIZED", "RECONCILIATION_REQUIRED"]),
    SUBMITTED: new Set(["FINALIZED", "RECONCILIATION_REQUIRED"]),
    FINALIZED: new Set(),
    FAILED_PRE_BROADCAST: new Set(),
    RECONCILIATION_REQUIRED: new Set(["SUBMITTED", "FINALIZED"])
});

export class OutgoingWalletOperationStoreError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = "OutgoingWalletOperationStoreError";
        this.code = "OUTGOING_WALLET_OPERATION_STORE_ERROR";
        this.details = Object.freeze({ ...details });
    }
}
function requiredText(value, field) {
    if (typeof value !== "string" || value.trim() === "") throw new OutgoingWalletOperationStoreError(`${field} must be a non-empty string`, { field });
    return value.trim();
}
function integer(value, field) {
    if (!Number.isSafeInteger(value) || value < 0) throw new OutgoingWalletOperationStoreError(`${field} must be a non-negative safe integer`, { field });
    return value;
}
function normalizeOperation(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new OutgoingWalletOperationStoreError("operation must be an object");
    const operationId = requiredText(input.operationId, "operationId");
    const idempotencyKey = requiredText(input.idempotencyKey, "idempotencyKey");
    const roomId = requiredText(input.roomId, "roomId");
    const sourceWalletAddress = requiredText(input.sourceWalletAddress, "sourceWalletAddress");
    const destination = requiredText(input.destination, "destination");
    if (tonAddressIdentityOrNull(sourceWalletAddress) === null || tonAddressIdentityOrNull(destination) === null) {
        throw new OutgoingWalletOperationStoreError("source and destination must be valid TON addresses");
    }
    const amountAtomic = integer(input.amountAtomic, "amountAtomic");
    if (amountAtomic <= 0) throw new OutgoingWalletOperationStoreError("amountAtomic must be positive");
    if (input.networkName !== "TESTNET" || input.globalId !== -3) throw new OutgoingWalletOperationStoreError("operation must be explicitly TON Testnet");
    const purpose = requiredText(input.purpose, "purpose");
    const createdAtMs = integer(input.createdAtMs, "createdAtMs");
    const state = input.state ?? OUTGOING_WALLET_OPERATION_STATE.PREPARED;
    if (!Object.hasOwn(ALLOWED_TRANSITIONS, state)) throw new OutgoingWalletOperationStoreError("operation state is invalid", { state });
    const expectedSeqno = input.expectedSeqno == null ? null : integer(input.expectedSeqno, "expectedSeqno");
    const transactionId = input.transactionId == null ? null : requiredText(input.transactionId, "transactionId");
    const blockId = input.blockId == null ? null : requiredText(input.blockId, "blockId");
    const actualFeeAtomic = input.actualFeeAtomic == null ? null : integer(input.actualFeeAtomic, "actualFeeAtomic");
    const finalizedAtMs = input.finalizedAtMs == null ? null : integer(input.finalizedAtMs, "finalizedAtMs");
    if (state === OUTGOING_WALLET_OPERATION_STATE.PREPARED && expectedSeqno !== null) throw new OutgoingWalletOperationStoreError("PREPARED operation must not have a seqno");
    if ([OUTGOING_WALLET_OPERATION_STATE.SEQNO_RESERVED, OUTGOING_WALLET_OPERATION_STATE.SUBMISSION_UNKNOWN,
        OUTGOING_WALLET_OPERATION_STATE.SUBMITTED, OUTGOING_WALLET_OPERATION_STATE.FINALIZED,
        OUTGOING_WALLET_OPERATION_STATE.RECONCILIATION_REQUIRED].includes(state) && expectedSeqno === null) {
        throw new OutgoingWalletOperationStoreError("operation state requires a persisted expectedSeqno", { state });
    }
    if (state === OUTGOING_WALLET_OPERATION_STATE.FINALIZED && (!transactionId || !blockId || actualFeeAtomic === null || finalizedAtMs === null)) {
        throw new OutgoingWalletOperationStoreError("FINALIZED requires transaction, block, actual fee and finalization time");
    }
    if (actualFeeAtomic !== null && state !== OUTGOING_WALLET_OPERATION_STATE.FINALIZED) throw new OutgoingWalletOperationStoreError("actual fee may only be recorded with FINALIZED evidence");
    return Object.freeze({
        schemaVersion: SCHEMA_VERSION, operationId, idempotencyKey, roomId, sourceWalletAddress, destination,
        amountAtomic, purpose, networkName: "TESTNET", globalId: -3, createdAtMs, state, expectedSeqno,
        transactionId, blockId, actualFeeAtomic, finalizedAtMs,
        updatedAtMs: integer(input.updatedAtMs ?? createdAtMs, "updatedAtMs"),
        revision: integer(input.revision ?? 0, "revision")
    });
}

export class OutgoingWalletOperationStore {
    constructor({ filePath, nowProvider = Date.now, idFactory = randomUUID } = {}) {
        if (typeof filePath !== "string" || filePath.trim() === "") throw new OutgoingWalletOperationStoreError("filePath is required");
        if (typeof nowProvider !== "function" || typeof idFactory !== "function") throw new OutgoingWalletOperationStoreError("nowProvider and idFactory must be functions");
        this._filePath = filePath;
        this._now = nowProvider;
        this._idFactory = idFactory;
        this._initialized = false;
        this._records = new Map();
        this._idempotency = new Map();
    }
    initialize() {
        if (this._initialized) return this.list();
        mkdirSync(dirname(this._filePath), { recursive: true });
        let payload;
        try { payload = JSON.parse(readFileSync(this._filePath, "utf8")); }
        catch (error) {
            if (error?.code !== "ENOENT") throw new OutgoingWalletOperationStoreError("operation journal is unreadable or corrupt");
            payload = { schemaVersion: SCHEMA_VERSION, operations: [] };
        }
        if (!payload || payload.schemaVersion !== SCHEMA_VERSION || !Array.isArray(payload.operations)) throw new OutgoingWalletOperationStoreError("operation journal schema is invalid");
        const records = new Map();
        const idempotency = new Map();
        for (const raw of payload.operations) {
            const op = normalizeOperation(raw);
            if (records.has(op.operationId) || idempotency.has(op.idempotencyKey)) throw new OutgoingWalletOperationStoreError("operation journal contains duplicate identity");
            records.set(op.operationId, op);
            idempotency.set(op.idempotencyKey, op.operationId);
        }
        this._records = records;
        this._idempotency = idempotency;
        this._initialized = true;
        if (!this._exists()) this._persist();
        return this.list();
    }
    create(input) {
        this._assertInitialized();
        const idempotencyKey = requiredText(input?.idempotencyKey, "idempotencyKey");
        const existingId = this._idempotency.get(idempotencyKey);
        if (existingId) {
            const existing = this._records.get(existingId);
            const candidate = normalizeOperation({
                ...input, operationId: existing.operationId, createdAtMs: existing.createdAtMs,
                updatedAtMs: existing.updatedAtMs, revision: existing.revision, state: existing.state,
                expectedSeqno: existing.expectedSeqno, transactionId: existing.transactionId, blockId: existing.blockId,
                actualFeeAtomic: existing.actualFeeAtomic, finalizedAtMs: existing.finalizedAtMs
            });
            const immutable = ["roomId", "amountAtomic", "purpose", "networkName", "globalId"];
            if (immutable.some((key) => candidate[key] !== existing[key])
                || !tonAddressIdentitiesEqual(candidate.sourceWalletAddress, existing.sourceWalletAddress)
                || !tonAddressIdentitiesEqual(candidate.destination, existing.destination)) {
                throw new OutgoingWalletOperationStoreError("idempotency key reused for a different outgoing operation");
            }
            return Object.freeze({ operation: existing, created: false });
        }
        const now = integer(this._now(), "nowProvider");
        const op = normalizeOperation({
            ...input, operationId: input.operationId ?? this._idFactory(), createdAtMs: input.createdAtMs ?? now,
            updatedAtMs: now, state: OUTGOING_WALLET_OPERATION_STATE.PREPARED, expectedSeqno: null,
            transactionId: null, blockId: null, actualFeeAtomic: null, finalizedAtMs: null, revision: 0
        });
        if (this._records.has(op.operationId)) throw new OutgoingWalletOperationStoreError("operationId already exists");
        this._records.set(op.operationId, op);
        this._idempotency.set(op.idempotencyKey, op.operationId);
        try { this._persist(); }
        catch (error) { this._records.delete(op.operationId); this._idempotency.delete(op.idempotencyKey); throw error; }
        return Object.freeze({ operation: op, created: true });
    }
    get(operationId) {
        this._assertInitialized();
        return this._records.get(requiredText(operationId, "operationId")) ?? null;
    }
    list() {
        this._assertInitialized();
        return Object.freeze([...this._records.values()].sort((a, b) => a.createdAtMs - b.createdAtMs || a.operationId.localeCompare(b.operationId)));
    }
    listByWallet(sourceWalletAddress) {
        this._assertInitialized();
        if (tonAddressIdentityOrNull(sourceWalletAddress) === null) throw new OutgoingWalletOperationStoreError("source wallet address is invalid");
        return Object.freeze(this.list().filter((op) => tonAddressIdentitiesEqual(op.sourceWalletAddress, sourceWalletAddress)));
    }
    transition({ operationId, expectedRevision, nextState, expectedSeqno, transactionId, blockId, actualFeeAtomic, finalizedAtMs } = {}) {
        this._assertInitialized();
        const id = requiredText(operationId, "operationId");
        const current = this._records.get(id);
        if (!current) throw new OutgoingWalletOperationStoreError("operation not found", { operationId: id });
        if (current.revision !== expectedRevision) throw new OutgoingWalletOperationStoreError("operation revision conflict", { operationId: id, expectedRevision, actualRevision: current.revision });
        if (!ALLOWED_TRANSITIONS[current.state]?.has(nextState)) throw new OutgoingWalletOperationStoreError("illegal outgoing operation state transition", { operationId: id, from: current.state, to: nextState });
        const next = normalizeOperation({
            ...current, state: nextState,
            expectedSeqno: expectedSeqno === undefined ? current.expectedSeqno : expectedSeqno,
            transactionId: transactionId === undefined ? current.transactionId : transactionId,
            blockId: blockId === undefined ? current.blockId : blockId,
            actualFeeAtomic: actualFeeAtomic === undefined ? current.actualFeeAtomic : actualFeeAtomic,
            finalizedAtMs: finalizedAtMs === undefined ? current.finalizedAtMs : finalizedAtMs,
            updatedAtMs: integer(this._now(), "nowProvider"), revision: current.revision + 1
        });
        this._records.set(id, next);
        try { this._persist(); } catch (error) { this._records.set(id, current); throw error; }
        return next;
    }
    _assertInitialized() {
        if (!this._initialized) throw new OutgoingWalletOperationStoreError("initialize() must be called first");
    }
    _exists() {
        try { readFileSync(this._filePath); return true; }
        catch (error) { if (error?.code === "ENOENT") return false; throw error; }
    }
    _persist() {
        const payload = JSON.stringify({ schemaVersion: SCHEMA_VERSION, operations: [...this._records.values()] }, null, 2);
        const temporaryPath = join(dirname(this._filePath), `.${randomUUID()}.tmp`);
        try {
            writeFileSync(temporaryPath, payload, { encoding: "utf8", flag: "wx", mode: 0o600 });
            renameSync(temporaryPath, this._filePath);
        } catch {
            try { unlinkSync(temporaryPath); } catch {}
            throw new OutgoingWalletOperationStoreError("failed to persist outgoing operation journal");
        }
    }
}

/**
 * Per-process FIFO queue keyed by canonical TON wallet identity. This prevents
 * overlapping operations in one Node process only; it is NOT a distributed
 * lock and must not be used across multiple server replicas.
 */
export class InProcessWalletOperationQueue {
    constructor() { this._tails = new Map(); }
    run(sourceWalletAddress, task) {
        if (tonAddressIdentityOrNull(sourceWalletAddress) === null) throw new OutgoingWalletOperationStoreError("source wallet address is invalid");
        if (typeof task !== "function") throw new OutgoingWalletOperationStoreError("task must be a function");
        const identity = tonAddressIdentityOrNull(sourceWalletAddress);
        const previous = this._tails.get(identity) ?? Promise.resolve();
        const current = previous.catch(() => {}).then(task);
        const tail = current.finally(() => {
            if (this._tails.get(identity) === tail) this._tails.delete(identity);
        });
        this._tails.set(identity, tail);
        return current;
    }
}
