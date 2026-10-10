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

/**
 * Deterministic 64-bit TON internal-message queryId for one refund intent.
 * It survives process restart and distinguishes sessions/seats even when two
 * players receive the same amount to the same wallet. It is a correlation key,
 * not financial authority.
 */
export function buildRefundQueryId(session, participant, seat) {
    const intentId = String(session?.paymentSessionId ?? session?.roomId ?? "").trim();
    const playerId = String(participant?.playerId ?? "").trim();
    const wallet = String(participant?.wallet ?? "").trim();
    const playerIndex = Number(seat);

    if (!intentId || !playerId || !wallet || !Number.isInteger(playerIndex) || playerIndex < 0) {
        return null;
    }

    const digest = createHash("sha256")
        .update("wheelwin:room-wallet-refund:v1|")
        .update(JSON.stringify([intentId, playerId, playerIndex, wallet]))
        .digest("hex")
        .slice(0, 16);

    return BigInt("0x" + digest).toString(10);
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
            amount: participant.paidAmount || participant.requiredGram,
            queryId: buildRefundQueryId(session, participant, seat)
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
