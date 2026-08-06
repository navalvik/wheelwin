import { InvalidSettlementStateTransitionError } from "./ContractSettlementManagerErrors.js";
import {
    canTransitionSettlementStatus,
    isSettlementSessionInProgress,
    isSettlementSessionTerminal,
    SETTLEMENT_SESSION_STATUS
} from "./SettlementSessionStates.js";

/**
 * T2.8 — Settlement session domain model.
 */
export class SettlementSession {

    constructor({
        settlementSessionId,
        contractId,
        gameId,
        roomId,
        winnerId,
        winnerWallet,
        prizeAmount,
        organizerAmount = null,
        totalPot = null,
        network = null,
        status = SETTLEMENT_SESSION_STATUS.CREATED,
        settlementTransactionHash = null,
        createdAt = Date.now(),
        updatedAt = Date.now(),
        completedAt = null,
        correlationId = null,
        version = 1,
        ownerWallet = null,
        traceSeed = null,
        startedAt = null,
        failedAt = null,
        reason = null,
        request = null,
        recoveryMetadata = null,
        settlementDeadline = null
    }) {

        this.settlementSessionId = settlementSessionId;

        this.contractId = contractId;

        this.gameId = gameId;

        this.roomId = roomId;

        this.winnerId = winnerId;

        this.winnerWallet = winnerWallet;

        this.prizeAmount = prizeAmount;

        this.organizerAmount = organizerAmount;

        this.totalPot = totalPot;

        this.network = network;

        this.status = status;

        this.settlementTransactionHash = settlementTransactionHash ?? null;

        this.createdAt = createdAt;

        this.updatedAt = updatedAt;

        this.completedAt = completedAt;

        this.correlationId = correlationId ?? null;

        this.version = version;

        this.ownerWallet = ownerWallet ?? null;

        this.traceSeed = traceSeed ?? null;

        this.startedAt = startedAt ?? createdAt;

        this.failedAt = failedAt ?? null;

        this.reason = reason ?? null;

        this.request = request ?? null;

        this.recoveryMetadata = recoveryMetadata ?? null;

        this.settlementDeadline = settlementDeadline ?? null;

    }

    static fromRecord(record) {

        const payload = record?.payload ?? record ?? {};

        return new SettlementSession({
            settlementSessionId: payload.settlementSessionId ?? record?.recordId,
            contractId: payload.contractId ?? record?.contractId ?? null,
            gameId: payload.gameId ?? record?.gameId ?? null,
            roomId: payload.roomId ?? record?.roomId ?? null,
            winnerId: payload.winnerId ?? null,
            winnerWallet: payload.winnerWallet ?? null,
            prizeAmount: payload.prizeAmount ?? payload.winnerAmount ?? null,
            organizerAmount: payload.organizerAmount ?? null,
            totalPot: payload.totalPot ?? null,
            network: payload.network ?? record?.tonNetwork ?? null,
            status: payload.status ?? SETTLEMENT_SESSION_STATUS.CREATED,
            settlementTransactionHash: payload.settlementTransactionHash
                ?? payload.settlementTxHash
                ?? null,
            createdAt: payload.createdAt ?? record?.createdAt ?? Date.now(),
            updatedAt: payload.updatedAt ?? record?.updatedAt ?? Date.now(),
            completedAt: payload.completedAt ?? null,
            correlationId: payload.correlationId ?? record?.correlationId ?? null,
            version: payload.version ?? record?.version ?? 1,
            ownerWallet: payload.ownerWallet ?? null,
            traceSeed: payload.traceSeed ?? null,
            startedAt: payload.startedAt ?? null,
            failedAt: payload.failedAt ?? null,
            reason: payload.reason ?? null,
            request: payload.request ?? null,
            recoveryMetadata: payload.recoveryMetadata ?? null,
            settlementDeadline: payload.settlementDeadline ?? null
        });

    }

    get winnerAmount() {

        return this.prizeAmount;

    }

    get settlementTxHash() {

        return this.settlementTransactionHash;

    }

    transitionTo(nextStatus, patch = {}) {

        if (!canTransitionSettlementStatus(this.status, nextStatus)) {

            throw new InvalidSettlementStateTransitionError(
                this.settlementSessionId,
                this.status,
                nextStatus
            );

        }

        this.status = nextStatus;

        this.updatedAt = patch.updatedAt ?? Date.now();

        if (patch.settlementTransactionHash !== undefined) {

            this.settlementTransactionHash = patch.settlementTransactionHash;

        }

        if (patch.completedAt !== undefined) {

            this.completedAt = patch.completedAt;

        }

        if (patch.failedAt !== undefined) {

            this.failedAt = patch.failedAt;

        }

        if (patch.reason !== undefined) {

            this.reason = patch.reason;

        }

        if (patch.request !== undefined) {

            this.request = patch.request;

        }

        if (patch.recoveryMetadata !== undefined) {

            this.recoveryMetadata = patch.recoveryMetadata;

        }

        this.version += 1;

        return this;

    }

    isInProgress() {

        return isSettlementSessionInProgress(this.status);

    }

    isTerminal() {

        return isSettlementSessionTerminal(this.status);

    }

    toPayload() {

        return Object.freeze({
            settlementSessionId: this.settlementSessionId,
            contractId: this.contractId,
            gameId: this.gameId,
            roomId: this.roomId,
            winnerId: this.winnerId,
            winnerWallet: this.winnerWallet,
            prizeAmount: this.prizeAmount,
            winnerAmount: this.prizeAmount,
            organizerAmount: this.organizerAmount,
            totalPot: this.totalPot,
            network: this.network,
            status: this.status,
            settlementTransactionHash: this.settlementTransactionHash,
            settlementTxHash: this.settlementTransactionHash,
            createdAt: this.createdAt,
            updatedAt: this.updatedAt,
            completedAt: this.completedAt,
            correlationId: this.correlationId,
            version: this.version,
            ownerWallet: this.ownerWallet,
            traceSeed: this.traceSeed,
            startedAt: this.startedAt,
            failedAt: this.failedAt,
            reason: this.reason,
            settlementDeadline: this.settlementDeadline,
            recoveryMetadata: this.recoveryMetadata,
            // R7.66I — Persist request so GameEscrow payout watches can re-register
            // after restart (needs contractAddress / wallets / amounts).
            request: this.request
        });

    }

    toDashboardSnapshot() {

        const now = Date.now();

        const remainingMs = this.settlementDeadline != null
            ? Math.max(0, this.settlementDeadline - now)
            : null;

        return Object.freeze({
            settlementSessionId: this.settlementSessionId,
            contractId: this.contractId,
            gameId: this.gameId,
            roomId: this.roomId,
            winnerId: this.winnerId,
            winnerWallet: this.winnerWallet,
            prizeAmount: this.prizeAmount,
            network: this.network,
            status: this.status,
            settlementTransactionHash: this.settlementTransactionHash,
            remainingMs,
            correlationId: this.correlationId,
            version: this.version
        });

    }

    toLegacyRecord() {

        return {
            gameId: this.gameId,
            roomId: this.roomId,
            contractId: this.contractId,
            status: this.status,
            winnerId: this.winnerId,
            winnerWallet: this.winnerWallet,
            winnerAmount: this.prizeAmount,
            organizerAmount: this.organizerAmount,
            totalPot: this.totalPot,
            settlementTxHash: this.settlementTransactionHash,
            startedAt: this.startedAt,
            completedAt: this.completedAt,
            failedAt: this.failedAt,
            reason: this.reason,
            request: this.request
        };

    }

}
