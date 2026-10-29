import test from "node:test";
import assert from "node:assert/strict";
import {
    createPaymentStatusRequest,
    hasSubmissionAcknowledgement,
    PAYMENT_QR_DISPLAYED_STATE,
    PAYMENT_SUBMISSION_ACKNOWLEDGED_STATE,
    PAYMENT_SUBMISSION_PENDING_STATE,
    PAYMENT_SUBMISSION_UNKNOWN_STATE,
    submissionAttemptIsActive
} from "./paymentStatusRequest.js";

function storageWith(value) {
    return { getItem: key => key === "wheelwin:payment:ref-a" ? value : null };
}

test("displaying QR requests observation but does not assert submission or settlement", () => {
    const storage = storageWith(PAYMENT_QR_DISPLAYED_STATE);
    const payload = createPaymentStatusRequest({
        roomId:"Room-A", playerId:"player-a", trigger:"PAYMENT_QR_DISPLAYED",
        paymentSubmissionAcknowledged:hasSubmissionAcknowledgement(storage, "ref-a")
    });
    assert.equal(payload.observationRequested, true);
    assert.equal(payload.observationTrigger, "PAYMENT_QR_DISPLAYED");
    assert.equal(payload.paymentSubmissionAcknowledged, false);
    assert.equal("paymentSettled" in payload, false);
    assert.equal(submissionAttemptIsActive(storage, "ref-a"), false);
});

test("pending or failed wallet callbacks do not count as acknowledgement, and never settle", () => {
    for (const state of [PAYMENT_SUBMISSION_PENDING_STATE, PAYMENT_SUBMISSION_UNKNOWN_STATE]) {
        const storage = storageWith(state);
        assert.equal(submissionAttemptIsActive(storage, "ref-a"), true);
        assert.equal(hasSubmissionAcknowledgement(storage, "ref-a"), false);
        assert.equal(createPaymentStatusRequest({
            roomId:"Room-A", playerId:"player-a",
            paymentSubmissionAcknowledged:hasSubmissionAcknowledgement(storage, "ref-a")
        }).observationRequested, true);
    }
});

test("TonConnect acknowledgement is diagnostic and observation works without it", () => {
    const storage = storageWith(PAYMENT_SUBMISSION_ACKNOWLEDGED_STATE);
    const request = createPaymentStatusRequest({
        roomId:"Room-A", playerId:"player-b",
        paymentSubmissionAcknowledged:hasSubmissionAcknowledgement(storage, "ref-a")
    });
    assert.equal(request.observationRequested, true);
    assert.equal(request.paymentSubmissionAcknowledged, true);
    assert.equal("paymentSettled" in request, false);
});
