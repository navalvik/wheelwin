import { PAYMENT_PARTICIPANT_STATUS } from "../models/PaymentSession.js";

/**
 * R17.8O.1 — Partial payment escrow unwind helpers.
 */

export function sessionNeedsEscrowUnwind(session) {

    if (!session) {

        return false;

    }

    if (typeof session.allConfirmed === "function" && session.allConfirmed()) {

        return false;

    }

    const confirmed = typeof session.confirmedCount === "function"
        ? session.confirmedCount()
        : 0;

    return confirmed > 0;

}

export function buildPartialPaymentRefundTargets(session) {

    const refunds = [];

    let expectedRefundMask = 0;

    for (const [index, participant] of (session?.participants ?? []).entries()) {

        const seat = participant.playerIndex == null
            ? index
            : Number(participant.playerIndex);

        const paid = participant.status === PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED
            || Number(participant.paidAmount) > 0;

        if (!paid) {

            continue;

        }

        expectedRefundMask |= (1 << seat);

        refunds.push(Object.freeze({
            playerIndex: seat,
            playerId: participant.playerId ?? null,
            wallet: participant.wallet ?? null,
            amount: participant.paidAmount || participant.requiredGram
        }));

    }

    return Object.freeze({
        refunds: Object.freeze(refunds),
        expectedRefundMask
    });

}

export function countConfirmedParticipants(session) {

    return typeof session?.confirmedCount === "function"
        ? session.confirmedCount()
        : 0;

}

export function allConfirmedParticipantsRefunded(session) {

    if (!session) {

        return true;

    }

    for (const participant of session.participants ?? []) {

        const paid = participant.status === PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED
            || Number(participant.paidAmount) > 0;

        if (paid && participant.refunded !== true) {

            return false;

        }

    }

    return true;

}
