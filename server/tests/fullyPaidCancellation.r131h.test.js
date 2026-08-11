/**
 * R13.1H — FULLY_PAID cancellation policy.
 */
import assert from "node:assert/strict";

import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import {
    PAYMENT_PARTICIPANT_STATUS,
    PAYMENT_SESSION_STATUS,
    PaymentSession
} from "../models/PaymentSession.js";
import { PaymentSessionManager } from "../gameplay/PaymentSessionManager.js";

function createLogger() {

    return {
        info() {},
        error() {},
        warn() {},
        debug() {},
        decisionTrace() {}
    };

}

function buildManager() {

    const logger = createLogger();
    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    const manager = new PaymentSessionManager({
        logger,
        eventBus,
        playerManager: { getIdentity() { return null; } },
        roomManager: {
            getRoom() {
                return { roomId: "room-1", players: ["p1"] };
            }
        },
        roomConfig: { paymentSessionDurationMs: 60_000 }
    });

    manager.initialize();

    return { manager, eventBus, logger };

}

function fullyPaidSession() {

    return new PaymentSession({
        paymentSessionId: "pay_full",
        roomId: "room-1",
        gameId: "game-1",
        status: PAYMENT_SESSION_STATUS.FULLY_PAID,
        completedAt: Date.now(),
        participants: [
            {
                playerId: "p1",
                wallet: "wallet-A",
                requiredGram: 1,
                status: PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED
            }
        ]
    });

}

console.log("R13.1H FULLY_PAID cancellation tests");

// A — Client cancel after FULLY_PAID rejected
{

    const { manager, eventBus } = buildManager();

    const session = fullyPaidSession();

    manager._sessionsByRoom.set("room-1", session);

    const result = manager.reportPlayerCancel("room-1", "p1");

    assert.equal(result, null, "player cancel must be rejected");
    assert.equal(
        manager.getSession?.("room-1")?.status
            ?? manager._sessionsByRoom.get("room-1").status,
        PAYMENT_SESSION_STATUS.FULLY_PAID
    );

    manager.shutdown?.();
    eventBus.shutdown();
    console.log("  A. client cancelPayment after FULLY_PAID → REJECT");

}

// B — Disconnect does not cancel FULLY_PAID (reportPlayerCancel no-op)
{

    const { manager, eventBus } = buildManager();

    const session = fullyPaidSession();

    manager._sessionsByRoom.set("room-1", session);

    manager.reportPlayerCancel("room-1", "p1");
    manager.reportPlayerCancel("room-1", "p1");

    assert.equal(
        manager._sessionsByRoom.get("room-1").status,
        PAYMENT_SESSION_STATUS.FULLY_PAID
    );
    assert.equal(
        manager._sessionsByRoom.get("room-1").findParticipant("p1").status,
        PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED
    );

    manager.shutdown?.();
    eventBus.shutdown();
    console.log("  B. disconnect/player cancel after FULLY_PAID → NO CANCEL");

}

// C — Authorized emergency cancel via GAME_ESCROW_CANCEL_CONFIRMED
{

    const { manager, eventBus } = buildManager();

    const session = fullyPaidSession();

    manager._sessionsByRoom.set("room-1", session);

    manager._handleGameEscrowCancelConfirmed({
        roomId: "room-1",
        reason: "AUTHORIZED_EMERGENCY_CANCEL"
    });

    assert.equal(
        manager._sessionsByRoom.get("room-1").status,
        PAYMENT_SESSION_STATUS.CANCELLED,
        "authorized on-chain emergency cancel must be allowed"
    );

    manager.shutdown?.();
    eventBus.shutdown();
    console.log("  C. authorized emergency cancel → ALLOWED");

}

// Extra — confirmed seat cannot player-cancel while session still in progress
{

    const { manager, eventBus } = buildManager();

    const session = new PaymentSession({
        paymentSessionId: "pay_partial",
        roomId: "room-1",
        gameId: "game-1",
        status: PAYMENT_SESSION_STATUS.PARTIALLY_PAID,
        participants: [
            {
                playerId: "p1",
                wallet: "wallet-A",
                requiredGram: 1,
                status: PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED
            },
            {
                playerId: "p2",
                wallet: "wallet-B",
                requiredGram: 1,
                status: PAYMENT_PARTICIPANT_STATUS.AWAITING_PLAYER_CONFIRMATION
            }
        ]
    });

    manager._sessionsByRoom.set("room-1", session);

    manager.reportPlayerCancel("room-1", "p1");

    assert.equal(
        session.findParticipant("p1").status,
        PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED
    );

    manager.shutdown?.();
    eventBus.shutdown();
    console.log("  extra. confirmed seat player-cancel → REJECT");

}

console.log("R13.1H FULLY_PAID cancellation tests passed");
