import {
    canTransitionPaymentStatus,
    isPaymentSessionInProgress,
    isPaymentSessionTerminal,
    PAYMENT_SESSION_LIFECYCLE_STATUS
} from "../gameplay/PaymentSessionStates.js";
import { InvalidPaymentStateTransitionError } from "../gameplay/PaymentSessionManagerErrors.js";

export const PAYMENT_PARTICIPANT_STATUS = Object.freeze({
    WAITING: "WAITING",
    PAYMENT_REQUESTED: "PAYMENT_REQUESTED",
    AWAITING_PLAYER_CONFIRMATION: "AWAITING_PLAYER_CONFIRMATION",
    PAYMENT_SUBMITTED: "PAYMENT_SUBMITTED",
    BLOCKCHAIN_PENDING: "BLOCKCHAIN_PENDING",
    PAYMENT_CONFIRMED: "PAYMENT_CONFIRMED",
    PAYMENT_FAILED: "PAYMENT_FAILED"
});

export const PAYMENT_CONFIRMATION_STATUS = Object.freeze({
    NONE: "NONE",
    DETECTED: "DETECTED",
    CONFIRMED: "CONFIRMED",
    REJECTED: "REJECTED",
    FAILED: "FAILED"
});

/**
 * P6.3 / T2.7 — Payment session statuses.
 * Legacy ACTIVE/COMPLETED/FAILED alias the T2.7 lifecycle values.
 */
export const PAYMENT_SESSION_STATUS = Object.freeze({
    ...PAYMENT_SESSION_LIFECYCLE_STATUS,
    ACTIVE: PAYMENT_SESSION_LIFECYCLE_STATUS.WAITING_FOR_PAYMENTS,
    COMPLETED: PAYMENT_SESSION_LIFECYCLE_STATUS.FULLY_PAID,
    FAILED: PAYMENT_SESSION_LIFECYCLE_STATUS.PAYMENT_FAILED
});

/**
 * P6.3 / T2.7 — One player's seat inside an authoritative Payment Session.
 */
export class PaymentParticipant {

    constructor({
        playerId,
        requiredGram,
        status = PAYMENT_PARTICIPANT_STATUS.WAITING,
        wallet = null,
        walletSessionId = null,
        paymentReference = null,
        contractAddress = null,
        txHash = null,
        paidAmount = 0,
        confirmationStatus = PAYMENT_CONFIRMATION_STATUS.NONE,
        confirmedAt = null,
        playerIndex = null,
        refunded = false,
        refundTxHash = null
    }) {

        this.playerId = playerId;

        this.requiredGram = Number(requiredGram);

        this.status = status;

        this.wallet = wallet ?? null;

        this.walletSessionId = walletSessionId ?? null;

        this.paymentReference = paymentReference ?? null;

        this.contractAddress = contractAddress ?? null;

        this.txHash = txHash ?? null;

        this.paidAmount = Number(paidAmount) || 0;

        this.confirmationStatus = confirmationStatus ?? PAYMENT_CONFIRMATION_STATUS.NONE;

        this.confirmedAt = confirmedAt ?? null;

        this.playerIndex = playerIndex == null ? null : Number(playerIndex);

        this.refunded = refunded === true;

        this.refundTxHash = refundTxHash ?? null;

    }

    toSnapshot() {

        return Object.freeze({
            playerId: this.playerId,
            requiredGram: this.requiredGram,
            requiredAmount: this.requiredGram,
            status: this.status,
            wallet: this.wallet,
            walletAddress: this.wallet,
            walletSessionId: this.walletSessionId,
            paymentReference: this.paymentReference,
            contractAddress: this.contractAddress,
            txHash: this.txHash,
            transactionHash: this.txHash,
            paidAmount: this.paidAmount,
            confirmationStatus: this.confirmationStatus,
            confirmedAt: this.confirmedAt,
            playerIndex: this.playerIndex,
            refunded: this.refunded === true,
            refundTxHash: this.refundTxHash
        });

    }

}

/**
 * P6.3 / T2.7 — Authoritative entry Payment Session for one game / room.
 */
export class PaymentSession {

    constructor({
        paymentSessionId,
        roomId,
        gameId = null,
        contractId = null,
        network = null,
        participants,
        walletSessions = [],
        requiredPayments = null,
        receivedPayments = [],
        createdAt = Date.now(),
        updatedAt = Date.now(),
        expiresAt = null,
        paymentDeadline = null,
        status = PAYMENT_SESSION_STATUS.WAITING_FOR_PAYMENTS,
        completedAt = null,
        correlationId = null,
        version = 1,
        recoveryMetadata = null
    }) {

        this.paymentSessionId = paymentSessionId;

        this.roomId = roomId;

        this.gameId = gameId ?? null;

        this.contractId = contractId ?? null;

        this.network = network ?? null;

        this.createdAt = createdAt;

        this.updatedAt = updatedAt;

        this.expiresAt = expiresAt ?? paymentDeadline ?? null;

        this.paymentDeadline = paymentDeadline ?? expiresAt ?? null;

        this.status = status;

        this.completedAt = completedAt;

        this.correlationId = correlationId ?? null;

        this.version = version;

        this.recoveryMetadata = recoveryMetadata ?? null;

        this.participants = (participants ?? []).map((entry) => (
            entry instanceof PaymentParticipant
                ? entry
                : new PaymentParticipant(entry)
        ));

        this.walletSessions = Object.freeze([...(walletSessions ?? [])]);

        this.requiredPayments = Object.freeze(
            requiredPayments
                ?? this.participants.map((participant) => Object.freeze({
                    playerId: participant.playerId,
                    walletSessionId: participant.walletSessionId,
                    walletAddress: participant.wallet,
                    requiredAmount: participant.requiredGram
                }))
        );

        this.receivedPayments = [...(receivedPayments ?? [])];

    }

    static fromRecord(record) {

        const payload = record?.payload ?? record ?? {};

        return new PaymentSession({
            paymentSessionId: payload.paymentSessionId ?? record?.recordId,
            roomId: payload.roomId,
            gameId: payload.gameId ?? null,
            contractId: payload.contractId ?? null,
            network: payload.network ?? record?.tonNetwork ?? null,
            participants: payload.participants ?? [],
            walletSessions: payload.walletSessions ?? [],
            requiredPayments: payload.requiredPayments ?? null,
            receivedPayments: payload.receivedPayments ?? [],
            createdAt: payload.createdAt ?? record?.createdAt ?? Date.now(),
            updatedAt: payload.updatedAt ?? record?.updatedAt ?? Date.now(),
            expiresAt: payload.expiresAt ?? payload.paymentDeadline ?? null,
            paymentDeadline: payload.paymentDeadline ?? payload.expiresAt ?? null,
            status: payload.status ?? PAYMENT_SESSION_STATUS.WAITING_FOR_PAYMENTS,
            completedAt: payload.completedAt ?? null,
            correlationId: payload.correlationId ?? record?.correlationId ?? null,
            version: payload.version ?? record?.version ?? 1,
            recoveryMetadata: payload.recoveryMetadata ?? null
        });

    }

    findParticipant(playerId) {

        return this.participants.find(
            (participant) => String(participant.playerId) === String(playerId)
        ) ?? null;

    }

    setParticipantStatus(playerId, status) {

        const participant = this.findParticipant(playerId);

        if (!participant) {

            return false;

        }

        if (!this.isInProgress()) {

            return false;

        }

        participant.status = status;

        return true;

    }

    confirmedCount() {

        return this.participants.filter(
            (participant) => (
                participant.status === PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED
            )
        ).length;

    }

    allConfirmed() {

        return this.participants.length > 0
            && this.participants.every(
                (participant) => (
                    participant.status === PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED
                )
            );

    }

    isInProgress() {

        return isPaymentSessionInProgress(this.status);

    }

    isTerminal() {

        return isPaymentSessionTerminal(this.status);

    }

    transitionTo(nextStatus, patch = {}) {

        if (!canTransitionPaymentStatus(this.status, nextStatus)) {

            throw new InvalidPaymentStateTransitionError(
                this.paymentSessionId,
                this.status,
                nextStatus
            );

        }

        this.status = nextStatus;

        this.updatedAt = patch.updatedAt ?? Date.now();

        if (patch.completedAt !== undefined) {

            this.completedAt = patch.completedAt;

        }

        if (patch.contractId !== undefined) {

            this.contractId = patch.contractId;

        }

        if (patch.network !== undefined) {

            this.network = patch.network;

        }

        if (patch.paymentDeadline !== undefined) {

            this.paymentDeadline = patch.paymentDeadline;

            this.expiresAt = patch.paymentDeadline;

        }

        if (patch.recoveryMetadata !== undefined) {

            this.recoveryMetadata = patch.recoveryMetadata;

        }

        if (patch.correlationId !== undefined) {

            this.correlationId = patch.correlationId;

        }

        this.version += 1;

        return this;

    }

    markPartiallyPaid() {

        if (this.status === PAYMENT_SESSION_STATUS.FULLY_PAID) {

            return this;

        }

        if (this.status === PAYMENT_SESSION_STATUS.PARTIALLY_PAID) {

            return this;

        }

        this.transitionTo(PAYMENT_SESSION_STATUS.PARTIALLY_PAID);

        return this;

    }

    markCompleted() {

        this.transitionTo(PAYMENT_SESSION_STATUS.FULLY_PAID, {
            completedAt: this.completedAt ?? Date.now()
        });

        return this;

    }

    markFailed() {

        this.transitionTo(PAYMENT_SESSION_STATUS.PAYMENT_FAILED);

        for (const participant of this.participants) {

            if (participant.status !== PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED) {

                participant.status = PAYMENT_PARTICIPANT_STATUS.PAYMENT_FAILED;

            }

        }

        return this;

    }

    markTimedOut() {

        this.transitionTo(PAYMENT_SESSION_STATUS.PAYMENT_TIMEOUT);

        for (const participant of this.participants) {

            if (participant.status !== PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED) {

                participant.status = PAYMENT_PARTICIPANT_STATUS.PAYMENT_FAILED;

            }

        }

        return this;

    }

    markCancelled() {

        if (this.status === PAYMENT_SESSION_STATUS.CANCELLED) {

            return this;

        }

        this.transitionTo(PAYMENT_SESSION_STATUS.CANCELLED, {
            completedAt: this.completedAt ?? Date.now()
        });

        return this;

    }

    addReceivedPayment(payment) {

        this.receivedPayments.push(Object.freeze({
            ...payment,
            recordedAt: payment.recordedAt ?? Date.now()
        }));

        this.updatedAt = Date.now();

        this.version += 1;

        return this;

    }

    toPayload() {

        return Object.freeze({
            paymentSessionId: this.paymentSessionId,
            roomId: this.roomId,
            gameId: this.gameId,
            contractId: this.contractId,
            network: this.network,
            players: this.participants.map((participant) => participant.playerId),
            walletSessions: this.walletSessions,
            requiredPayments: this.requiredPayments,
            receivedPayments: this.receivedPayments,
            participants: this.participants.map((participant) => participant.toSnapshot()),
            paymentDeadline: this.paymentDeadline,
            status: this.status,
            createdAt: this.createdAt,
            updatedAt: this.updatedAt,
            expiresAt: this.expiresAt,
            completedAt: this.completedAt,
            correlationId: this.correlationId,
            version: this.version,
            recoveryMetadata: this.recoveryMetadata
        });

    }

    toDashboardSnapshot() {

        const now = Date.now();

        const remainingMs = this.paymentDeadline != null
            ? Math.max(0, this.paymentDeadline - now)
            : null;

        return Object.freeze({
            paymentSessionId: this.paymentSessionId,
            roomId: this.roomId,
            gameId: this.gameId,
            contractId: this.contractId,
            network: this.network,
            status: this.status,
            paymentDeadline: this.paymentDeadline,
            remainingMs,
            confirmedCount: this.confirmedCount(),
            participantCount: this.participants.length,
            missingPayments: this.participants
                .filter((participant) => (
                    participant.status !== PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED
                ))
                .map((participant) => participant.toSnapshot()),
            participants: Object.freeze(
                this.participants.map((participant) => participant.toSnapshot())
            ),
            receivedPayments: Object.freeze([...this.receivedPayments]),
            correlationId: this.correlationId,
            version: this.version
        });

    }

    toSnapshot() {

        return Object.freeze({
            paymentSessionId: this.paymentSessionId,
            roomId: this.roomId,
            gameId: this.gameId,
            contractId: this.contractId,
            network: this.network,
            createdAt: this.createdAt,
            updatedAt: this.updatedAt,
            expiresAt: this.expiresAt,
            paymentDeadline: this.paymentDeadline,
            completedAt: this.completedAt,
            status: this.status,
            correlationId: this.correlationId,
            version: this.version,
            walletSessions: this.walletSessions,
            requiredPayments: this.requiredPayments,
            receivedPayments: Object.freeze([...this.receivedPayments]),
            participants: Object.freeze(
                this.participants.map((participant) => participant.toSnapshot())
            )
        });

    }

}
