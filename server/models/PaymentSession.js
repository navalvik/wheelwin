export const PAYMENT_PARTICIPANT_STATUS = Object.freeze({
    WAITING: "WAITING",
    PAYMENT_REQUESTED: "PAYMENT_REQUESTED",
    AWAITING_PLAYER_CONFIRMATION: "AWAITING_PLAYER_CONFIRMATION",
    PAYMENT_SUBMITTED: "PAYMENT_SUBMITTED",
    PAYMENT_CONFIRMED: "PAYMENT_CONFIRMED",
    PAYMENT_FAILED: "PAYMENT_FAILED"
});

export const PAYMENT_SESSION_STATUS = Object.freeze({
    ACTIVE: "ACTIVE",
    COMPLETED: "COMPLETED",
    FAILED: "FAILED"
});

/**
 * P6.3 — One player's seat inside an authoritative Payment Session.
 */
export class PaymentParticipant {

    constructor({
        playerId,
        requiredGram,
        status = PAYMENT_PARTICIPANT_STATUS.WAITING,
        wallet = null
    }) {

        this.playerId = playerId;

        this.requiredGram = Number(requiredGram);

        this.status = status;

        this.wallet = wallet ?? null;

    }

    toSnapshot() {

        return Object.freeze({
            playerId: this.playerId,
            requiredGram: this.requiredGram,
            status: this.status,
            wallet: this.wallet
        });

    }

}

/**
 * P6.3 — Authoritative entry Payment Session for one game / room.
 * No blockchain logic. Server owns every state transition.
 */
export class PaymentSession {

    constructor({
        paymentSessionId,
        roomId,
        gameId = null,
        participants,
        createdAt = Date.now(),
        expiresAt = null,
        status = PAYMENT_SESSION_STATUS.ACTIVE
    }) {

        this.paymentSessionId = paymentSessionId;

        this.roomId = roomId;

        this.gameId = gameId ?? null;

        this.createdAt = createdAt;

        this.expiresAt = expiresAt;

        this.status = status;

        this.participants = (participants ?? []).map((entry) => (
            entry instanceof PaymentParticipant
                ? entry
                : new PaymentParticipant(entry)
        ));

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

        if (this.status !== PAYMENT_SESSION_STATUS.ACTIVE) {

            return false;

        }

        participant.status = status;

        return true;

    }

    allConfirmed() {

        return this.participants.length > 0
            && this.participants.every(
                (participant) => (
                    participant.status === PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED
                )
            );

    }

    markCompleted() {

        this.status = PAYMENT_SESSION_STATUS.COMPLETED;

    }

    markFailed() {

        this.status = PAYMENT_SESSION_STATUS.FAILED;

        for (const participant of this.participants) {

            if (participant.status !== PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED) {

                participant.status = PAYMENT_PARTICIPANT_STATUS.PAYMENT_FAILED;

            }

        }

    }

    toSnapshot() {

        return Object.freeze({
            paymentSessionId: this.paymentSessionId,
            roomId: this.roomId,
            gameId: this.gameId,
            createdAt: this.createdAt,
            expiresAt: this.expiresAt,
            status: this.status,
            participants: Object.freeze(
                this.participants.map((participant) => participant.toSnapshot())
            )
        });

    }

}
