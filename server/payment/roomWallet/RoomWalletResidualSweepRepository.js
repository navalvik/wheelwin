/**
 * Durable room-level residual sweep records.
 *
 * Persistence only. No signing, no broadcast, no gameplay ledger writes.
 * Amounts are stored as decimal nanogram strings (JSON cannot hold bigint).
 */

import { randomUUID } from "node:crypto";

import {
    DuplicateRecordError,
    ImmutableRecordError,
    RecordNotFoundError,
    TonFinancialPersistence,
    TON_FINANCIAL_RECORD_TYPES
} from "../../persistence/TonFinancialPersistence.js";
import { ROOM_WALLET_POLICY } from "./RoomWalletFinancialPolicy.js";
import { normalizeRoomNumber } from "./RoomWalletRegistry.js";
import {
    RESIDUAL_SWEEP_STATUS,
    isResidualSweepInFlight,
    isResidualSweepStatus,
    isResidualSweepTerminal
} from "./residualSweepStates.js";

export function residualSweepRecordId() {
    return `rwsweep_${randomUUID()}`;
}

export function nanoToRecordString(value) {
    if (typeof value !== "bigint") {
        throw new TypeError("nano amount must be a bigint");
    }

    return value.toString(10);
}

export function recordStringToNano(value) {
    const raw = String(value ?? "").trim();

    if (!/^\d+$/.test(raw)) {
        throw new TypeError("nano record string must be a non-negative integer");
    }

    return BigInt(raw);
}

export class RoomWalletResidualSweepRepository {

    /**
     * @param {{ persistence: TonFinancialPersistence, tonNetwork?: string|null }} options
     */
    constructor({ persistence, tonNetwork = "testnet" } = {}) {
        if (!persistence) {
            throw new Error(
                "RoomWalletResidualSweepRepository requires TonFinancialPersistence"
            );
        }

        this._persistence = persistence;
        this._tonNetwork = tonNetwork ?? "testnet";
    }

    create({
        roomNumber,
        sourceAddress,
        destinationAddress,
        observedBalanceNano,
        amountNano = ROOM_WALLET_POLICY.residualSweepNano,
        retainedFloorNano = ROOM_WALLET_POLICY.residualRetainedFloorNano,
        sweepGasNano = ROOM_WALLET_POLICY.residualSweepGasNano,
        safetyMarginNano = ROOM_WALLET_POLICY.residualSafetyMarginNano,
        idempotencyKey = null
    } = {}) {
        const normalizedRoomNumber = normalizeRoomNumber(roomNumber);
        const source = String(sourceAddress ?? "").trim();
        const destination = String(destinationAddress ?? "").trim();

        if (!source || !destination) {
            throw new Error("residual sweep create requires source and destination addresses");
        }

        const inFlight = this.findInFlightByRoomNumber(normalizedRoomNumber);

        if (inFlight) {
            throw new DuplicateRecordError(
                TON_FINANCIAL_RECORD_TYPES.RESIDUAL_SWEEP,
                `roomNumber:${normalizedRoomNumber}`
            );
        }

        const now = Date.now();
        const recordId = residualSweepRecordId();
        const payload = {
            id: recordId,
            roomNumber: normalizedRoomNumber,
            sourceAddress: source,
            destinationAddress: destination,
            amountNano: nanoToRecordString(amountNano),
            retainedFloorNano: nanoToRecordString(retainedFloorNano),
            sweepGasNano: nanoToRecordString(sweepGasNano),
            safetyMarginNano: nanoToRecordString(safetyMarginNano),
            observedBalanceNano: nanoToRecordString(observedBalanceNano),
            status: RESIDUAL_SWEEP_STATUS.PENDING,
            txHash: null,
            seqno: null,
            idempotencyKey: idempotencyKey == null
                ? `room:${normalizedRoomNumber}:${now}`
                : String(idempotencyKey),
            createdAt: now,
            updatedAt: now,
            processedAt: null,
            submittedAt: null,
            confirmedAt: null,
            failedAt: null,
            failureReason: null,
            completedFinancialEvent: false
        };

        return this._persistence.createResidualSweepRecord(
            payload,
            {
                recordId,
                status: payload.status,
                roomId: null,
                gameId: null,
                contractId: null,
                tonNetwork: this._tonNetwork,
                correlationId: recordId,
                createdAt: now,
                updatedAt: now
            }
        );
    }

    findById(id) {
        const recordId = String(id ?? "").trim();

        if (!recordId) {
            return null;
        }

        try {
            return this._persistence.loadResidualSweepRecord(recordId);
        } catch (error) {
            if (error instanceof RecordNotFoundError) {
                return null;
            }

            throw error;
        }
    }

    listActive() {
        return this._persistence.listActive(
            TON_FINANCIAL_RECORD_TYPES.RESIDUAL_SWEEP
        );
    }

    findInFlightByRoomNumber(roomNumber) {
        const normalizedRoomNumber = normalizeRoomNumber(roomNumber);

        return this.listActive().find((record) => (
            Number(record.payload?.roomNumber) === normalizedRoomNumber
            && isResidualSweepInFlight(record.payload?.status)
        )) ?? null;
    }

    listPending() {
        const now = Date.now();

        return this.listActive().filter((record) => {
            const status = record.payload?.status;
            const txHash = String(record.payload?.txHash ?? "").trim();

            if (txHash) {
                return false;
            }

            if (status === RESIDUAL_SWEEP_STATUS.AWAITING_TRANSACTION_HASH) {
                return false;
            }

            if (status === RESIDUAL_SWEEP_STATUS.PENDING) {
                return true;
            }

            if (status === RESIDUAL_SWEEP_STATUS.FAILED_RETRY) {
                const nextRetryAt = record.payload?.nextRetryAt;

                if (nextRetryAt == null || nextRetryAt === "") {
                    return true;
                }

                const dueAt = Number(nextRetryAt);
                return Number.isFinite(dueAt) && dueAt <= now;
            }

            return false;
        });
    }

    listAwaitingConfirmation() {
        return this.listActive().filter((record) => {
            const status = record.payload?.status;
            const txHash = String(record.payload?.txHash ?? "").trim();

            if (!txHash) {
                return false;
            }

            return status === RESIDUAL_SWEEP_STATUS.PROCESSING
                || status === RESIDUAL_SWEEP_STATUS.AWAITING_TRANSACTION_HASH;
        });
    }

    listAwaitingTransactionHashWithoutBroadcastEvidence() {
        return this.listActive().filter((record) => (
            record.payload?.status === RESIDUAL_SWEEP_STATUS.AWAITING_TRANSACTION_HASH
            && !String(record.payload?.txHash ?? "").trim()
        ));
    }

    listProcessingWithoutHash() {
        return this.listActive().filter((record) => (
            record.payload?.status === RESIDUAL_SWEEP_STATUS.PROCESSING
            && !String(record.payload?.txHash ?? "").trim()
        ));
    }

    markProcessing(id, patch = {}) {
        return this.updateStatus(id, {
            status: RESIDUAL_SWEEP_STATUS.PROCESSING,
            processedAt: Date.now(),
            ...patch
        });
    }

    markSent(id, { txHash, seqno = null } = {}) {
        const hash = String(txHash ?? "").trim();

        if (!hash) {
            throw new Error("markSent requires txHash");
        }

        return this.updateStatus(id, {
            status: RESIDUAL_SWEEP_STATUS.PROCESSING,
            txHash: hash,
            seqno: seqno == null ? null : Number(seqno),
            submittedAt: Date.now(),
            processedAt: Date.now(),
            failureReason: null
        });
    }

    markAwaitingTransactionHash(id, { seqno = null } = {}) {
        return this.updateStatus(id, {
            status: RESIDUAL_SWEEP_STATUS.AWAITING_TRANSACTION_HASH,
            txHash: null,
            seqno: seqno == null ? null : Number(seqno),
            submittedAt: Date.now(),
            processedAt: Date.now(),
            failureReason: "awaiting_transaction_hash"
        });
    }

    markConfirmed(id, { txHash = null, confirmedAt = Date.now() } = {}) {
        const existing = this.findById(id);

        if (!existing) {
            throw new RecordNotFoundError(
                TON_FINANCIAL_RECORD_TYPES.RESIDUAL_SWEEP,
                id
            );
        }

        const hash = String(txHash ?? existing.payload?.txHash ?? "").trim();

        if (!hash) {
            throw new Error("markConfirmed requires txHash");
        }

        return this.updateStatus(id, {
            status: RESIDUAL_SWEEP_STATUS.CONFIRMED,
            txHash: hash,
            confirmedAt,
            completedFinancialEvent: true,
            failureReason: null
        });
    }

    markFailed(id, { terminal = false, failureReason = null, nextRetryAt = null } = {}) {
        return this.updateStatus(id, {
            status: terminal
                ? RESIDUAL_SWEEP_STATUS.FAILED_TERMINAL
                : RESIDUAL_SWEEP_STATUS.FAILED_RETRY,
            failedAt: Date.now(),
            failureReason,
            nextRetryAt: terminal
                ? null
                : (nextRetryAt == null ? Date.now() + 60_000 : nextRetryAt),
            completedFinancialEvent: false
        });
    }

    updateStatus(id, patch) {
        const existing = this.findById(id);

        if (!existing) {
            throw new RecordNotFoundError(
                TON_FINANCIAL_RECORD_TYPES.RESIDUAL_SWEEP,
                id
            );
        }

        if (
            existing.immutable
            || isResidualSweepTerminal(existing.payload?.status)
        ) {
            throw new ImmutableRecordError(
                TON_FINANCIAL_RECORD_TYPES.RESIDUAL_SWEEP,
                existing.recordId
            );
        }

        const nextStatus = patch.status ?? existing.payload.status;

        if (!isResidualSweepStatus(nextStatus)) {
            throw new Error(`invalid residual sweep status: ${nextStatus}`);
        }

        const payload = {
            ...existing.payload,
            ...patch,
            status: nextStatus,
            updatedAt: Date.now()
        };

        return this._persistence.updateResidualSweepRecord(
            existing.recordId,
            payload,
            {
                status: nextStatus,
                roomId: null,
                gameId: null,
                contractId: null,
                tonNetwork: existing.tonNetwork ?? this._tonNetwork,
                correlationId: existing.correlationId ?? existing.recordId,
                updatedAt: payload.updatedAt
            }
        );
    }
}
