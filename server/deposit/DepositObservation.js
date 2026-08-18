/**
 * R17.9L.7 — DepositMonitor blockchain observation model.
 * Observation facts only. Does not mutate DepositSession.
 */

import {
    TON_FINANCIAL_RECORD_TYPES
} from "../persistence/TonFinancialRecordTypes.js";
import { InvalidDepositObservationError } from "./DepositMonitorErrors.js";
import {
    DEPOSIT_OBSERVATION_STATUS
} from "./DepositObservationStates.js";
import { normalizeDepositIdPart, normalizeDepositWallet } from "./depositValidation.js";

export class DepositObservation {

    constructor({
        observationId = null,
        depositId,
        depositAddress,
        transactionHash,
        senderWallet,
        amount,
        timestamp = Date.now(),
        network = "testnet",
        observationStatus = DEPOSIT_OBSERVATION_STATUS.OBSERVED,
        rejectionReason = null,
        playerId = null,
        createdAt = Date.now(),
        updatedAt = null
    } = {}) {

        this.observationId = observationId
            ?? buildObservationId(depositId, transactionHash);

        this.depositId = depositId;

        this.depositAddress = depositAddress;

        this.transactionHash = transactionHash;

        this.senderWallet = senderWallet;

        this.amount = amount;

        this.timestamp = timestamp;

        this.network = network;

        this.observationStatus = observationStatus;

        this.rejectionReason = rejectionReason;

        this.playerId = playerId;

        this.createdAt = createdAt;

        this.updatedAt = updatedAt ?? createdAt;

    }

    static fromInput(input = {}) {

        const depositId = normalizeDepositIdPart(input.depositId);

        const depositAddress = normalizeDepositWallet(
            input.depositAddress ?? input.address
        );

        const transactionHash = normalizeDepositIdPart(
            input.transactionHash ?? input.txHash ?? input.fundingEventId
        );

        const senderWallet = normalizeDepositWallet(
            input.senderWallet ?? input.wallet ?? input.from
        );

        const amount = Number(input.amount);

        if (!depositId) {

            throw new InvalidDepositObservationError("depositId is required", {
                depositId: input.depositId ?? null
            });

        }

        if (!depositAddress) {

            throw new InvalidDepositObservationError("depositAddress is required", {
                depositId
            });

        }

        if (!transactionHash) {

            throw new InvalidDepositObservationError("transactionHash is required", {
                depositId
            });

        }

        if (!senderWallet) {

            throw new InvalidDepositObservationError("senderWallet is required", {
                depositId,
                transactionHash
            });

        }

        if (!Number.isFinite(amount) || amount <= 0) {

            throw new InvalidDepositObservationError("amount must be a positive number", {
                depositId,
                transactionHash,
                amount: input.amount
            });

        }

        const network = normalizeDepositIdPart(input.network) || "testnet";

        return new DepositObservation({
            depositId,
            depositAddress,
            transactionHash,
            senderWallet,
            amount,
            timestamp: Number(input.timestamp) || Date.now(),
            network,
            observationStatus: input.observationStatus
                ?? DEPOSIT_OBSERVATION_STATUS.OBSERVED,
            rejectionReason: input.rejectionReason ?? null,
            playerId: normalizeDepositIdPart(input.playerId) || null
        });

    }

    static fromRecord(record) {

        const payload = record?.payload ?? record ?? {};

        return new DepositObservation({
            observationId: payload.observationId ?? record?.recordId,
            depositId: payload.depositId,
            depositAddress: payload.depositAddress,
            transactionHash: payload.transactionHash,
            senderWallet: payload.senderWallet ?? payload.wallet,
            amount: payload.amount,
            timestamp: payload.timestamp ?? record?.createdAt ?? Date.now(),
            network: payload.network ?? payload.tonNetwork ?? record?.tonNetwork ?? "testnet",
            observationStatus: payload.observationStatus
                ?? payload.status
                ?? DEPOSIT_OBSERVATION_STATUS.OBSERVED,
            rejectionReason: payload.rejectionReason ?? null,
            playerId: payload.playerId ?? null,
            createdAt: payload.createdAt ?? record?.createdAt ?? Date.now(),
            updatedAt: payload.updatedAt ?? record?.updatedAt ?? Date.now()
        });

    }

    markValidated({ playerId = null } = {}) {

        this.observationStatus = DEPOSIT_OBSERVATION_STATUS.VALIDATED;

        this.playerId = playerId ?? this.playerId;

        this.updatedAt = Date.now();

        return this;

    }

    markRejected(rejectionReason) {

        this.observationStatus = DEPOSIT_OBSERVATION_STATUS.REJECTED;

        this.rejectionReason = rejectionReason;

        this.updatedAt = Date.now();

        return this;

    }

    toPayload() {

        return Object.freeze({
            observationId: this.observationId,
            depositId: this.depositId,
            depositAddress: this.depositAddress,
            transactionHash: this.transactionHash,
            senderWallet: this.senderWallet,
            wallet: this.senderWallet,
            amount: this.amount,
            timestamp: this.timestamp,
            network: this.network,
            tonNetwork: this.network,
            observationStatus: this.observationStatus,
            status: this.observationStatus,
            rejectionReason: this.rejectionReason,
            playerId: this.playerId,
            createdAt: this.createdAt,
            updatedAt: this.updatedAt
        });

    }

    toRecord() {

        return Object.freeze({
            recordType: TON_FINANCIAL_RECORD_TYPES.DEPOSIT_OBSERVATION,
            recordId: this.observationId,
            depositId: this.depositId,
            roomId: null,
            gameId: null,
            status: this.observationStatus,
            tonNetwork: this.network,
            createdAt: this.createdAt,
            updatedAt: this.updatedAt,
            payload: this.toPayload()
        });

    }

}

export function buildObservationId(depositId, transactionHash) {

    return `${normalizeDepositIdPart(depositId)}__${normalizeDepositIdPart(transactionHash)}`;

}
