import { EVENT_TYPES } from "../events/EventTypes.js";
import { GAME_MESSAGE_CHANNEL } from "./events.js";

// Authoritative payment lifecycle statuses forwarded to clients for display.
export const PAYMENT_CLIENT_STATUS = Object.freeze({
    STARTED: "STARTED",
    COMPLETED: "COMPLETED",
    FAILED: "FAILED"
});

export const PAYMENT_STATUS_MESSAGE_TYPES = Object.freeze({
    [EVENT_TYPES.PAYMENT_STARTED]: "PAYMENT_STARTED",
    [EVENT_TYPES.PAYMENT_COMPLETED]: "PAYMENT_COMPLETED",
    [EVENT_TYPES.PAYMENT_FAILED]: "PAYMENT_FAILED"
});

const EVENT_TO_STATUS = Object.freeze({
    [EVENT_TYPES.PAYMENT_STARTED]: PAYMENT_CLIENT_STATUS.STARTED,
    [EVENT_TYPES.PAYMENT_COMPLETED]: PAYMENT_CLIENT_STATUS.COMPLETED,
    [EVENT_TYPES.PAYMENT_FAILED]: PAYMENT_CLIENT_STATUS.FAILED
});

export function isForwardablePaymentEvent(eventType) {

    return Boolean(PAYMENT_STATUS_MESSAGE_TYPES[eventType]);

}

export function buildPaymentStatusPayload(eventType, paymentPayload) {

    return {
        gameId: paymentPayload?.gameId ?? null,
        status: EVENT_TO_STATUS[eventType] ?? null,
        winnerId: paymentPayload?.winnerId ?? null,
        winnerAmount: paymentPayload?.winnerAmount ?? null,
        reason: paymentPayload?.reason ?? null,
        serverTimestamp: paymentPayload?.timestamp ?? Date.now()
    };

}

export function buildPaymentStatusMessage(eventType, paymentPayload) {

    return {
        channel: GAME_MESSAGE_CHANNEL,
        message: {
            type: PAYMENT_STATUS_MESSAGE_TYPES[eventType],
            payload: buildPaymentStatusPayload(eventType, paymentPayload)
        }
    };

}
