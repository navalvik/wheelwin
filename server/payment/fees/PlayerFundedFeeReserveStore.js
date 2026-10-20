/**
 * Durable, idempotent store for player-funded network-fee reserves.
 *
 * This store persists accounting evidence only. It does not sign, submit, or
 * broadcast transfers, and it is not connected to payment acceptance.
 *
 * Atomic file replacement prevents partial JSON writes; idempotency conflicts
 * fail closed. Records intentionally contain no private keys or wallet secrets.
 */
import { dirname, join } from "node:path";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const SCHEMA_VERSION = 1;

export class PlayerFundedFeeReserveStoreError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = "PlayerFundedFeeReserveStoreError";
        this.code = "PLAYER_FUNDED_FEE_RESERVE_STORE_ERROR";
        this.details = Object.freeze({ ...details });
    }
}

function requiredText(value, field) {
    if (typeof value !== "string" || value.trim() === "") {
        throw new PlayerFundedFeeReserveStoreError(`${field} must be a non-empty string`, { field });
    }
    return value.trim();
}

function validateRecord(record) {
    if (!record || typeof record !== "object" || Array.isArray(record)
        || record.schemaVersion !== SCHEMA_VERSION) {
        throw new PlayerFundedFeeReserveStoreError("unsupported or invalid fee reserve record");
    }
    const idempotencyKey = requiredText(record.idempotencyKey, "idempotencyKey");
    const roomId = requiredText(record.roomId, "roomId");
    if (!Number.isSafeInteger(record.createdAtMs) || record.createdAtMs < 0) {
        throw new PlayerFundedFeeReserveStoreError("createdAtMs must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(record.totalReserveAtomic) || record.totalReserveAtomic < 0) {
        throw new PlayerFundedFeeReserveStoreError("totalReserveAtomic must be a non-negative safe integer");
    }
    if (!Array.isArray(record.contributions) || record.contributions.length !== 3) {
        throw new PlayerFundedFeeReserveStoreError("exactly three player contributions are required");
    }
    const seen = new Set();
    let sum = 0;
    const contributions = record.contributions.map((item) => {
        const playerId = requiredText(item?.playerId, "contribution.playerId");
        if (seen.has(playerId)) throw new PlayerFundedFeeReserveStoreError("duplicate player contribution");
        seen.add(playerId);
        if (!Number.isSafeInteger(item.amountAtomic) || item.amountAtomic < 0) {
            throw new PlayerFundedFeeReserveStoreError("contribution amount must be a non-negative safe integer");
        }
        sum += item.amountAtomic;
        if (!Number.isSafeInteger(sum)) throw new PlayerFundedFeeReserveStoreError("contribution sum overflow");
        return Object.freeze({ playerId, amountAtomic: item.amountAtomic });
    });
    if (sum !== record.totalReserveAtomic) {
        throw new PlayerFundedFeeReserveStoreError("player contributions do not equal the total fee reserve");
    }
    if (!Array.isArray(record.feeQuotes) || record.feeQuotes.length === 0) {
        throw new PlayerFundedFeeReserveStoreError("fee quote evidence is required");
    }

    // The persisted reserve must equal the sum of its own operation quotes.
    // Otherwise a malformed record could claim a larger/smaller player reserve
    // than the outgoing operations it is supposed to fund.
    const quoteOperationIds = new Set();
    let quotedFeeTotalAtomic = 0;
    for (const quote of record.feeQuotes) {
        const operationId = requiredText(quote?.operationId, "feeQuote.operationId");
        if (quoteOperationIds.has(operationId)) {
            throw new PlayerFundedFeeReserveStoreError("duplicate outgoing fee quote operation", {
                operationId
            });
        }
        quoteOperationIds.add(operationId);
        if (!Number.isSafeInteger(quote.feeAtomic) || quote.feeAtomic < 0) {
            throw new PlayerFundedFeeReserveStoreError("fee quote amount must be a non-negative safe integer", {
                operationId
            });
        }
        quotedFeeTotalAtomic += quote.feeAtomic;
        if (!Number.isSafeInteger(quotedFeeTotalAtomic)) {
            throw new PlayerFundedFeeReserveStoreError("fee quote total exceeds safe integer range");
        }
    }
    if (quotedFeeTotalAtomic !== record.totalReserveAtomic) {
        throw new PlayerFundedFeeReserveStoreError(
            "fee quote total does not equal the persisted player-funded reserve",
            { quotedFeeTotalAtomic, totalReserveAtomic: record.totalReserveAtomic }
        );
    }
    return Object.freeze({
        schemaVersion: SCHEMA_VERSION,
        idempotencyKey,
        roomId,
        createdAtMs: record.createdAtMs,
        currency: "TON",
        atomicUnit: "nanoton",
        totalReserveAtomic: record.totalReserveAtomic,
        contributions: Object.freeze(contributions),
        feeQuotes: Object.freeze(record.feeQuotes.map((quote) => {
            const operationId = requiredText(quote?.operationId, "feeQuote.operationId");
            if (!Number.isSafeInteger(quote.feeAtomic) || quote.feeAtomic < 0
                || !Number.isSafeInteger(quote.quotedAtMs) || quote.quotedAtMs < 0
                || !Number.isSafeInteger(quote.validForMs) || quote.validForMs <= 0) {
                throw new PlayerFundedFeeReserveStoreError("fee quote evidence contains invalid integer fields", {
                    operationId
                });
            }
            const estimateId = requiredText(quote.estimateId, "feeQuote.estimateId");
            const destination = requiredText(quote.destination, "feeQuote.destination");
            const purpose = requiredText(quote.purpose, "feeQuote.purpose");
            if (quote.networkName !== "TESTNET" || quote.globalId !== -3
                || quote.source !== "TONCENTER_FEE_ESTIMATE") {
                throw new PlayerFundedFeeReserveStoreError(
                    "fee quote must retain approved Testnet source identity", { operationId }
                );
            }
            return Object.freeze({
                operationId,
                estimateId,
                destination,
                purpose,
                networkName: quote.networkName,
                globalId: quote.globalId,
                source: quote.source,
                feeAtomic: quote.feeAtomic,
                quotedAtMs: quote.quotedAtMs,
                validForMs: quote.validForMs
            });
        })),
        state: record.state === "RECONCILED" ? "RECONCILED" : "RESERVED",
        reconciliation: record.reconciliation ? Object.freeze({ ...record.reconciliation }) : null
    });
}

export class PlayerFundedFeeReserveStore {
    constructor({ filePath, nowProvider = Date.now } = {}) {
        this._filePath = requiredText(filePath, "filePath");
        this._now = nowProvider;
        this._initialized = false;
        this._records = new Map();
        this._byIdempotencyKey = new Map();
    }

    initialize() {
        if (this._initialized) return this.list();
        mkdirSync(dirname(this._filePath), { recursive: true });
        let document;
        try {
            document = JSON.parse(readFileSync(this._filePath, "utf8"));
        } catch (error) {
            if (error?.code !== "ENOENT") {
                throw new PlayerFundedFeeReserveStoreError("fee reserve store is unreadable; refusing to overwrite", {
                    cause: error?.message
                });
            }
            document = { schemaVersion: SCHEMA_VERSION, records: [] };
        }
        if (document?.schemaVersion !== SCHEMA_VERSION || !Array.isArray(document.records)) {
            throw new PlayerFundedFeeReserveStoreError("fee reserve store schema is invalid; refusing to overwrite");
        }
        for (const raw of document.records) {
            const record = validateRecord(raw);
            if (this._records.has(record.idempotencyKey)
                || this._byIdempotencyKey.has(record.idempotencyKey)) {
                throw new PlayerFundedFeeReserveStoreError("duplicate persisted fee reserve idempotency key");
            }
            this._records.set(record.idempotencyKey, record);
            this._byIdempotencyKey.set(record.idempotencyKey, record);
        }
        this._initialized = true;
        return this.list();
    }

    create({ idempotencyKey, reserve }) {
        this._assertInitialized();
        const key = requiredText(idempotencyKey, "idempotencyKey");
        if (!reserve || typeof reserve !== "object") {
            throw new PlayerFundedFeeReserveStoreError("reserve object is required");
        }
        const candidate = validateRecord({
            schemaVersion: SCHEMA_VERSION,
            idempotencyKey: key,
            roomId: reserve.roomId,
            createdAtMs: this._now(),
            totalReserveAtomic: reserve.totalReserveAtomic,
            contributions: reserve.contributions,
            feeQuotes: reserve.feeQuotes,
            state: "RESERVED",
            reconciliation: null
        });
        const existing = this._byIdempotencyKey.get(key);
        if (existing) {
            const sameBusinessRecord = existing.roomId === candidate.roomId
                && existing.totalReserveAtomic === candidate.totalReserveAtomic
                && JSON.stringify(existing.contributions) === JSON.stringify(candidate.contributions)
                && JSON.stringify(existing.feeQuotes) === JSON.stringify(candidate.feeQuotes);
            if (!sameBusinessRecord) {
                throw new PlayerFundedFeeReserveStoreError("idempotency key conflicts with an existing fee reserve", {
                    idempotencyKey: key
                });
            }
            return Object.freeze({ replay: true, record: existing });
        }
        this._byIdempotencyKey.set(key, candidate);
        try {
            this._persist();
        } catch (error) {
            this._byIdempotencyKey.delete(key);
            throw error;
        }
        return Object.freeze({ replay: false, record: candidate });
    }

    reconcile({ idempotencyKey, reconciliation }) {
        this._assertInitialized();
        const key = requiredText(idempotencyKey, "idempotencyKey");
        const existing = this._byIdempotencyKey.get(key);
        if (!existing) throw new PlayerFundedFeeReserveStoreError("fee reserve does not exist", { idempotencyKey: key });
        if (!reconciliation || reconciliation.settlementAllowed !== true
            || !Number.isSafeInteger(reconciliation.reservedAtomic)
            || reconciliation.reservedAtomic !== existing.totalReserveAtomic
            || !Number.isSafeInteger(reconciliation.actualAtomic)
            || reconciliation.actualAtomic < 0
            || reconciliation.actualAtomic > existing.totalReserveAtomic
            || reconciliation.surplusAtomic !== existing.totalReserveAtomic - reconciliation.actualAtomic) {
            throw new PlayerFundedFeeReserveStoreError("fee reconciliation is inconsistent or exceeds the reserve");
        }
        if (existing.state === "RECONCILED") {
            const prior = existing.reconciliation;
            const same = prior.reservedAtomic === reconciliation.reservedAtomic
                && prior.actualAtomic === reconciliation.actualAtomic
                && prior.surplusAtomic === reconciliation.surplusAtomic
                && prior.surplusDisposition === reconciliation.surplusDisposition;
            if (!same) {
                throw new PlayerFundedFeeReserveStoreError("fee reserve already reconciled with conflicting actual-fee evidence", {
                    idempotencyKey: key
                });
            }
            return existing;
        }
        const next = Object.freeze({
            ...existing,
            state: "RECONCILED",
            reconciliation: Object.freeze({
                reservedAtomic: reconciliation.reservedAtomic,
                actualAtomic: reconciliation.actualAtomic,
                surplusAtomic: reconciliation.surplusAtomic,
                reconciledAtMs: this._now(),
                surplusDisposition: requiredText(reconciliation.surplusDisposition, "surplusDisposition")
            })
        });
        this._byIdempotencyKey.set(key, next);
        try {
            this._persist();
        } catch (error) {
            this._byIdempotencyKey.set(key, existing);
            throw error;
        }
        return next;
    }

    get(idempotencyKey) {
        this._assertInitialized();
        return this._byIdempotencyKey.get(requiredText(idempotencyKey, "idempotencyKey")) ?? null;
    }

    list() {
        this._assertInitialized();
        return Object.freeze([...this._byIdempotencyKey.values()]);
    }

    _persist() {
        const document = JSON.stringify({
            schemaVersion: SCHEMA_VERSION,
            records: [...this._byIdempotencyKey.values()]
        }, null, 2);
        const tempPath = join(dirname(this._filePath), `.fee-reserve-${randomUUID()}.tmp`);
        try {
            writeFileSync(tempPath, document, { encoding: "utf8", mode: 0o600, flag: "wx" });
            renameSync(tempPath, this._filePath);
        } catch (error) {
            throw new PlayerFundedFeeReserveStoreError("failed to persist fee reserve atomically", {
                cause: error?.message
            });
        }
    }

    _assertInitialized() {
        if (!this._initialized) throw new PlayerFundedFeeReserveStoreError("fee reserve store is not initialized");
    }
}
