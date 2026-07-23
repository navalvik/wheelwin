import assert from "node:assert/strict";

import {
    PAYMENT_PARTICIPANT_STATUS,
    PAYMENT_SESSION_STATUS,
    PaymentParticipant,
    PaymentSession
} from "../models/PaymentSession.js";

import { calculateRequiredGram } from "../payment/calculateRequiredGram.js";

assert.equal(calculateRequiredGram(10, 1), 10);

assert.equal(calculateRequiredGram(10, 2), 25);

assert.equal(calculateRequiredGram(null, 1), null);

const session = new PaymentSession({
    paymentSessionId: "pay_test",
    roomId: "room-1",
    gameId: "game-1",
    createdAt: 1000,
    expiresAt: 2000,
    participants: [
        new PaymentParticipant({
            playerId: "p1",
            requiredGram: 10
        }),
        new PaymentParticipant({
            playerId: "p2",
            requiredGram: 25
        }),
        new PaymentParticipant({
            playerId: "p3",
            requiredGram: 10
        })
    ]
});

assert.equal(session.status, PAYMENT_SESSION_STATUS.ACTIVE);

assert.equal(
    session.findParticipant("p1").status,
    PAYMENT_PARTICIPANT_STATUS.WAITING
);

assert.equal(session.setParticipantStatus("p1", PAYMENT_PARTICIPANT_STATUS.PAYMENT_REQUESTED), true);

assert.equal(
    session.findParticipant("p1").status,
    PAYMENT_PARTICIPANT_STATUS.PAYMENT_REQUESTED
);

assert.equal(session.allConfirmed(), false);

for (const playerId of ["p1", "p2", "p3"]) {

    session.setParticipantStatus(
        playerId,
        PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED
    );

}

assert.equal(session.allConfirmed(), true);

session.markCompleted();

assert.equal(session.status, PAYMENT_SESSION_STATUS.COMPLETED);

const failed = new PaymentSession({
    paymentSessionId: "pay_fail",
    roomId: "room-2",
    gameId: "game-2",
    participants: [
        { playerId: "a", requiredGram: 1, status: PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED },
        { playerId: "b", requiredGram: 1, status: PAYMENT_PARTICIPANT_STATUS.AWAITING_PLAYER_CONFIRMATION }
    ]
});

failed.markFailed();

assert.equal(failed.status, PAYMENT_SESSION_STATUS.FAILED);

assert.equal(
    failed.findParticipant("a").status,
    PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED
);

assert.equal(
    failed.findParticipant("b").status,
    PAYMENT_PARTICIPANT_STATUS.PAYMENT_FAILED
);

const snapshot = session.toSnapshot();

assert.equal(snapshot.paymentSessionId, "pay_test");

assert.equal(snapshot.participants.length, 3);

assert.equal(Object.isFrozen(snapshot), true);

console.log("paymentSession.model.test.js: all assertions passed");
