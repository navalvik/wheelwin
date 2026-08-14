/**
 * R17.8O.1 — Partial payment escrow unwind tests.
 */
import assert from "node:assert/strict";

import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { GameContractManager } from "../gameplay/GameContractManager.js";
import { PaymentSessionManager } from "../gameplay/PaymentSessionManager.js";
import { GAME_CONTRACT_STATUS } from "../models/GameContract.js";
import {
    PAYMENT_PARTICIPANT_STATUS,
    PAYMENT_SESSION_STATUS,
    PaymentSession
} from "../models/PaymentSession.js";

function createLogger() {

    return {
        info() {},
        error() {},
        warn() {},
        debug() {},
        decisionTrace() {}
    };

}

function partialSession() {

    return new PaymentSession({
        paymentSessionId: "pay-partial",
        roomId: "room-partial",
        gameId: "game-partial",
        status: PAYMENT_SESSION_STATUS.PARTIALLY_PAID,
        participants: [
            {
                playerId: "p1",
                playerIndex: 0,
                wallet: "wallet-A",
                requiredGram: 10,
                status: PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED,
                paidAmount: 10
            },
            {
                playerId: "p2",
                playerIndex: 1,
                wallet: "wallet-B",
                requiredGram: 10,
                status: PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED,
                paidAmount: 10
            },
            {
                playerId: "p3",
                playerIndex: 2,
                wallet: "wallet-C",
                requiredGram: 10,
                status: PAYMENT_PARTICIPANT_STATUS.AWAITING_PLAYER_CONFIRMATION
            }
        ]
    });

}

function buildHarness({
    cancelResult = { ok: true, txId: "cancel-tx-1" },
    cancelThrows = false
} = {}) {

    const logger = createLogger();
    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    const cancelCalls = [];
    const refundWatchCalls = [];

    const deployAdapter = {
        async cancel(payload) {

            cancelCalls.push(payload);

            if (cancelThrows) {

                throw new Error("cancel_broadcast_failed");

            }

            return cancelResult;

        }
    };

    const blockchainMonitor = {
        watchGameEscrowRefunds(payload) {

            refundWatchCalls.push(payload);

            return { watchId: "refund-watch-1" };

        },
        stopRoom() {}
    };

    const gameContractManager = new GameContractManager({
        logger,
        eventBus,
        playerManager: { getIdentity() { return null; } },
        roomManager: {
            getRoom(roomId) {

                return roomId === "room-partial"
                    ? { roomId, players: ["p1", "p2", "p3"] }
                    : null;

            }
        },
        deployAdapter,
        devMode: false
    });

    gameContractManager.initialize();

    gameContractManager.setEscrowUnwindDeps({ blockchainMonitor });

    gameContractManager._contractsByRoom.set("room-partial", {
        contractId: "contract-partial",
        roomId: "room-partial",
        gameId: "game-partial",
        contractAddress: "EQescrow-partial",
        status: GAME_CONTRACT_STATUS.AWAITING_PLAYER_PAYMENTS,
        correlationId: "corr-partial"
    });

    gameContractManager._roomByGameId.set("game-partial", "room-partial");

    const paymentSessionManager = new PaymentSessionManager({
        logger,
        eventBus,
        playerManager: { getIdentity() { return null; } },
        roomManager: {
            getRoom(roomId) {

                return roomId === "room-partial"
                    ? { roomId, players: ["p1", "p2", "p3"] }
                    : null;

            }
        },
        gameContractManager,
        blockchainMonitor,
        devMode: false
    });

    paymentSessionManager.initialize();

    gameContractManager.setFinancialEvidenceDeps({
        paymentSessionManager
    });

    const events = [];

    for (const type of [
        EVENT_TYPES.ESCROW_CANCEL_REQUESTED,
        EVENT_TYPES.ESCROW_CANCEL_CONFIRMED,
        EVENT_TYPES.ESCROW_CANCEL_FAILED,
        EVENT_TYPES.ESCROW_REFUND_PENDING,
        EVENT_TYPES.ESCROW_REFUND_CONFIRMED,
        EVENT_TYPES.PAYMENT_SESSION_FAILED
    ]) {

        eventBus.subscribe(type, (envelope) => {

            events.push({ type, payload: envelope.payload });

        });

    }

    return {
        logger,
        eventBus,
        gameContractManager,
        paymentSessionManager,
        cancelCalls,
        refundWatchCalls,
        events
    };

}

async function waitForAsync() {

    await new Promise((resolve) => setTimeout(resolve, 0));

}

console.log("R17.8O.1 partial payment escrow unwind tests");

// A — Partial payment timeout triggers cancel + refund watch; room close deferred.
{

    const harness = buildHarness();

    harness.paymentSessionManager._sessionsByRoom.set(
        "room-partial",
        partialSession()
    );

    const failedBeforeUnwind = [];

    harness.eventBus.subscribe(
        EVENT_TYPES.PAYMENT_SESSION_FAILED,
        () => failedBeforeUnwind.push(true)
    );

    harness.paymentSessionManager.failSession("room-partial", "payment_timeout");

    assert.equal(
        harness.paymentSessionManager.getSession("room-partial").status,
        PAYMENT_SESSION_STATUS.REFUND_PENDING
    );

    assert.equal(failedBeforeUnwind.length, 0, "room must not close before refunds");

    await waitForAsync();

    assert.equal(harness.cancelCalls.length, 1);
    assert.equal(harness.cancelCalls[0].contractAddress, "EQescrow-partial");
    assert.equal(harness.refundWatchCalls.length, 1);
    assert.equal(harness.refundWatchCalls[0].cancelTxHash, "cancel-tx-1");
    assert.equal(harness.refundWatchCalls[0].refunds.length, 2);

    harness.paymentSessionManager._handleGameEscrowRefundConfirmed({
        roomId: "room-partial",
        playerId: "p1",
        transactionId: "refund-tx-1"
    });

    assert.equal(failedBeforeUnwind.length, 0, "still waiting for second refund");

    harness.paymentSessionManager._handleGameEscrowRefundConfirmed({
        roomId: "room-partial",
        playerId: "p2",
        transactionId: "refund-tx-2"
    });

    assert.equal(failedBeforeUnwind.length, 1);
    assert.equal(
        harness.paymentSessionManager.getSession("room-partial").status,
        PAYMENT_SESSION_STATUS.CANCELLED
    );

    harness.paymentSessionManager.shutdown?.();
    harness.gameContractManager.shutdown?.();
    harness.eventBus.shutdown();

    console.log("  A. partial payment timeout → cancel + deferred room close");

}

// B — Full payment must not trigger cancel.
{

    const harness = buildHarness();

    const session = new PaymentSession({
        paymentSessionId: "pay-full",
        roomId: "room-partial",
        gameId: "game-partial",
        status: PAYMENT_SESSION_STATUS.FULLY_PAID,
        participants: [
            {
                playerId: "p1",
                wallet: "wallet-A",
                requiredGram: 10,
                status: PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED
            },
            {
                playerId: "p2",
                wallet: "wallet-B",
                requiredGram: 10,
                status: PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED
            },
            {
                playerId: "p3",
                wallet: "wallet-C",
                requiredGram: 10,
                status: PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED
            }
        ]
    });

    harness.paymentSessionManager._sessionsByRoom.set("room-partial", session);

    harness.paymentSessionManager.failSession("room-partial", "payment_timeout");

    await waitForAsync();

    assert.equal(harness.cancelCalls.length, 0);
    assert.equal(harness.refundWatchCalls.length, 0);

    harness.paymentSessionManager.shutdown?.();
    harness.gameContractManager.shutdown?.();
    harness.eventBus.shutdown();

    console.log("  B. full payment → cancel NOT called");

}

// C — Creator leave during partial payment uses unwind path.
{

    const harness = buildHarness();

    harness.paymentSessionManager._sessionsByRoom.set(
        "room-partial",
        partialSession()
    );

    harness.paymentSessionManager.failSession("room-partial", "creator_left");

    await waitForAsync();

    assert.equal(harness.cancelCalls.length, 1);
    assert.equal(
        harness.paymentSessionManager.getSession("room-partial").status,
        PAYMENT_SESSION_STATUS.REFUND_PENDING
    );

    harness.paymentSessionManager.shutdown?.();
    harness.gameContractManager.shutdown?.();
    harness.eventBus.shutdown();

    console.log("  C. creator_left during partial payment → escrow cancel");

}

// D — Cancel failure preserves contract reference and skips room failure emit.
{

    const harness = buildHarness({
        cancelResult: { ok: false, reason: "cancel_failed" }
    });

    harness.paymentSessionManager._sessionsByRoom.set(
        "room-partial",
        partialSession()
    );

    const failedEvents = [];

    harness.eventBus.subscribe(
        EVENT_TYPES.PAYMENT_SESSION_FAILED,
        () => failedEvents.push(true)
    );

    harness.paymentSessionManager.failSession("room-partial", "payment_timeout");

    await waitForAsync();

    assert.equal(
        harness.events.some(
            (entry) => entry.type === EVENT_TYPES.ESCROW_CANCEL_FAILED
        ),
        true
    );
    assert.equal(failedEvents.length, 0);
    assert.equal(
        harness.gameContractManager.getContract("room-partial")?.contractAddress,
        "EQescrow-partial"
    );
    assert.equal(
        harness.gameContractManager._escrowUnwindByRoom.get("room-partial")?.state,
        "failed"
    );

    harness.paymentSessionManager.shutdown?.();
    harness.gameContractManager.shutdown?.();
    harness.eventBus.shutdown();

    console.log("  D. cancel failure → ESCROW_CANCEL_FAILED + contract preserved");

}

console.log("R17.8O.1 partial payment escrow unwind tests passed");
