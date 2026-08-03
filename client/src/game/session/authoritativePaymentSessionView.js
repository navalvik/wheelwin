/**
 * P6.3/P6.5 — Authoritative Payment Session view helpers for Page4.
 */

import { resolveWheelIcon } from "../../components/game/WheelEngine/wheelUtils.js";

export const PAYMENT_PARTICIPANT_STATUS = Object.freeze({
    WAITING: "WAITING",
    PAYMENT_REQUESTED: "PAYMENT_REQUESTED",
    AWAITING_PLAYER_CONFIRMATION: "AWAITING_PLAYER_CONFIRMATION",
    PAYMENT_SUBMITTED: "PAYMENT_SUBMITTED",
    BLOCKCHAIN_PENDING: "BLOCKCHAIN_PENDING",
    PAYMENT_CONFIRMED: "PAYMENT_CONFIRMED",
    PAYMENT_FAILED: "PAYMENT_FAILED"
});

function resolveDisplayIcon(icon) {

    if (icon == null || icon === "" || icon === "—") {

        return "—";

    }

    return resolveWheelIcon(icon);

}

export function hasPaymentSession(paymentSession) {

    return Array.isArray(paymentSession?.participants)
        && paymentSession.participants.length > 0;

}

export function shouldShowPaymentSessionWaiting(paymentSession) {

    return !hasPaymentSession(paymentSession);

}

export function mapPaymentParticipantStatusLabel(status) {

    switch (status) {

        case PAYMENT_PARTICIPANT_STATUS.PAYMENT_REQUESTED:
            return "Payment Requested";

        case PAYMENT_PARTICIPANT_STATUS.AWAITING_PLAYER_CONFIRMATION:
            return "Waiting for Confirmation";

        case PAYMENT_PARTICIPANT_STATUS.PAYMENT_SUBMITTED:
            return "Waiting for Blockchain...";

        case PAYMENT_PARTICIPANT_STATUS.BLOCKCHAIN_PENDING:
            return "Waiting for Blockchain...";

        case PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED:
            return "Payment Confirmed";

        case PAYMENT_PARTICIPANT_STATUS.PAYMENT_FAILED:
            return "Payment failed";

        case PAYMENT_PARTICIPANT_STATUS.WAITING:
        default:
            return "Preparing payment...";

    }

}

export function mapPaymentSessionRows(paymentSession, playersById = {}) {

    if (!Array.isArray(paymentSession?.participants)) {

        return [];

    }

    return paymentSession.participants.map((seat, index) => {

        const roster = playersById?.[seat.playerId] ?? null;

        return {
            key: seat.playerId ?? `payment-${index}`,
            playerId: seat.playerId,
            labelTitle: index === 0 ? "YOUR NICKNAME" : "PLAYER NICKNAME",
            nickname: roster?.nickname ?? "—",
            icon: resolveDisplayIcon(roster?.icon),
            requiredGram: seat.requiredGram ?? null,
            wallet: seat.wallet ?? null,
            paymentReference: seat.paymentReference ?? null,
            contractAddress: seat.contractAddress ?? null,
            status: seat.status ?? PAYMENT_PARTICIPANT_STATUS.WAITING,
            statusLabel: mapPaymentParticipantStatusLabel(seat.status)
        };

    });

}

const CONFIRMABLE_PAYMENT_SESSION_STATUSES = new Set([
    // Legacy P6.3 wire value
    "ACTIVE",
    // T2.7 lifecycle values (ACTIVE aliases WAITING_FOR_PAYMENTS server-side)
    "WAITING_FOR_PAYMENTS",
    "PARTIALLY_PAID",
    "RECOVERED"
]);

export function canConfirmLocalPayment(paymentSession, localPlayerId) {

    if (!localPlayerId || !hasPaymentSession(paymentSession)) {

        return false;

    }

    if (
        paymentSession.status
        && !CONFIRMABLE_PAYMENT_SESSION_STATUSES.has(paymentSession.status)
    ) {

        return false;

    }

    const seat = paymentSession.participants.find(
        (participant) => String(participant.playerId) === String(localPlayerId)
    );

    return seat?.status === PAYMENT_PARTICIPANT_STATUS.AWAITING_PLAYER_CONFIRMATION;

}

export function getLocalPaymentRequest(paymentSession, localPlayerId) {

    if (!localPlayerId || !hasPaymentSession(paymentSession)) {

        return null;

    }

    return paymentSession.participants.find(
        (participant) => String(participant.playerId) === String(localPlayerId)
    ) ?? null;

}
