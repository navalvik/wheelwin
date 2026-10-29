export const PAYMENT_QR_DISPLAYED_STATE = "PAYMENT_QR_DISPLAYED";
export const PAYMENT_SUBMISSION_PENDING_STATE = "SUBMISSION_PENDING";
export const PAYMENT_SUBMISSION_ACKNOWLEDGED_STATE = "PAYMENT_SUBMISSION_ACKNOWLEDGED";
export const PAYMENT_SUBMISSION_UNKNOWN_STATE = "SUBMISSION_UNKNOWN";

/** A wallet callback is only diagnostic; it never means blockchain settlement. */
export function hasSubmissionAcknowledgement(storage, paymentReference) {
    if (!paymentReference) return false;
    return storage?.getItem?.(`wheelwin:payment:${paymentReference}`)
        === PAYMENT_SUBMISSION_ACKNOWLEDGED_STATE;
}

export function submissionAttemptIsActive(storage, paymentReference) {
    if (!paymentReference) return false;
    const state = storage?.getItem?.(`wheelwin:payment:${paymentReference}`);
    return state === PAYMENT_SUBMISSION_PENDING_STATE
        || state === PAYMENT_SUBMISSION_ACKNOWLEDGED_STATE
        || state === PAYMENT_SUBMISSION_UNKNOWN_STATE;
}

/** Observation intent and wallet acknowledgement stay separate fields. */
export function createPaymentStatusRequest({
    roomId,
    playerId,
    trigger = "PAGE4_ACTIVE",
    paymentSubmissionAcknowledged = false
}) {
    return {
        roomId,
        playerId,
        observationRequested: true,
        observationTrigger: trigger,
        paymentSubmissionAcknowledged: paymentSubmissionAcknowledged === true
    };
}
