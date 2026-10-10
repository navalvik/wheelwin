import { createHash } from "node:crypto";
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

/**
 * R18.XSDd — Room-Wallet paid-funds check for setup-expiry refunds.
 *
 * Unlike sessionNeedsEscrowUnwind (escrow-era semantics: false when
 * allConfirmed), this returns true whenever the session still holds
 * received/confirmed player funds that have not been refunded —
 * including a FULLY_PAID session. A fully paid setup session that
 * expires before GAME_INITIALIZED must refund all three payments
 * from the Room Wallet.
 */
export function sessionHasUnrefundedPaidFunds(session) {

    if (!session) {

        return false;

    }

    for (const participant of session.participants ?? []) {

        const paid = participant.status === PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED
            || Number(participant.paidAmount) > 0;

        if (paid && participant.refunded !== true) {

            return true;

        }

    }

    return false;

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

        const sessionIdentity = String(
            session.paymentSessionId
                ?? session.correlationId
                ?? String(session.roomId ?? "unknown-room") + ":" + String(session.createdAt ?? session.updatedAt ?? "unknown-time")
        );
        const queryId = createHash("sha256")
            .update([
                "wheelwin-room-wallet-refund-v1",
                sessionIdentity,
                String(participant.playerId ?? ""),
                String(seat),
                String(participant.wallet ?? "").trim()
            ].join("|"))
            .digest()
            .readBigUInt64BE(0)
            .toString(10);

        refunds.push(Object.freeze({
            playerIndex: seat,
            playerId: participant.playerId ?? null,
            wallet: participant.wallet ?? null,
            queryId,
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
