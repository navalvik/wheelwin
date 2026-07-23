import assert from "node:assert/strict";

import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { PaymentSessionManager } from "../gameplay/PaymentSessionManager.js";
import {
    PAYMENT_PARTICIPANT_STATUS,
    PAYMENT_SESSION_STATUS
} from "../models/PaymentSession.js";

function createLogger() {

    return {
        info() {},
        error() {},
        warn() {},
        debug() {}
    };

}

function wait(ms) {

    return new Promise((resolve) => setTimeout(resolve, ms));

}

function createHarness({ durationMs = 60_000 } = {}) {

    const logger = createLogger();

    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    const identities = new Map([
        ["p1", { baseStake: 10, sectorCount: 1 }],
        ["p2", { baseStake: 10, sectorCount: 2 }],
        ["p3", { baseStake: 10, sectorCount: 1 }]
    ]);

    const playerManager = {
        getIdentity(playerId) {

            return identities.get(playerId) ?? null;

        }
    };

    const roomManager = {
        getRoom(roomId) {

            if (roomId !== "room-1") {

                return null;

            }

            return { players: ["p1", "p2", "p3"] };

        }
    };

    const gameplayContextResolver = {
        resolveGameIdByRoomId(roomId) {

            return roomId === "room-1" ? "game-1" : null;

        }
    };

    const sessionWalletStore = {
        getWallet() {

            return "EQtestwallet";

        }
    };

    const manager = new PaymentSessionManager({
        logger,
        eventBus,
        playerManager,
        roomManager,
        roomConfig: { paymentSessionDurationMs: durationMs },
        gameplayContextResolver,
        sessionWalletStore,
        devMode: false
    });

    manager.initialize();

    return { eventBus, manager };

}

{
    const { eventBus, manager } = createHarness();

    const created = [];

    const requests = [];

    const updated = [];

    eventBus.subscribe(EVENT_TYPES.PAYMENT_SESSION_CREATED, (envelope) => {

        created.push(envelope.payload);

    });

    eventBus.subscribe(EVENT_TYPES.PAYMENT_REQUEST, (envelope) => {

        requests.push(envelope.payload);

    });

    eventBus.subscribe(EVENT_TYPES.PAYMENT_SESSION_UPDATED, (envelope) => {

        updated.push(envelope.payload);

    });

    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.PAYMENT_CONNECTION_READY,
        payload: { roomId: "room-1" }
    });

    assert.equal(created.length, 1, "PAYMENT_SESSION_CREATED once");

    assert.equal(created[0].gameId, "game-1");

    assert.equal(
        requests.length,
        0,
        "PAYMENT_REQUEST waits until Game Contract is DEPLOYED"
    );

    const session = manager.getSession("room-1");

    assert.ok(session, "session keyed by room");

    assert.equal(manager.getSessionByGameId("game-1"), session);

    assert.ok(
        session.participants.every(
            (participant) => (
                participant.status
                    === PAYMENT_PARTICIPANT_STATUS.PAYMENT_REQUESTED
            )
        ),
        "all seats stay PAYMENT_REQUESTED until deploy"
    );

    manager.issueDeployedPaymentRequests("room-1", {
        contractAddress: "EQdeployedcontractaddressxxxxxxxxxxxx",
        paymentDeadline: Date.now() + 60_000
    });

    assert.equal(requests.length, 3, "PAYMENT_REQUEST for every player after deploy");

    assert.ok(
        requests.every((request) => (
            request.requiredGram > 0
            && request.paymentDeadline
            && request.paymentSessionId
            && request.contractAddress
            && request.paymentReference
        )),
        "PAYMENT_REQUEST carries contract address and reference"
    );

    assert.ok(
        session.participants.every(
            (participant) => (
                participant.status
                    === PAYMENT_PARTICIPANT_STATUS.AWAITING_PLAYER_CONFIRMATION
            )
        ),
        "all seats await confirmation after deployed requests"
    );

    manager.submitPlayerConfirmation("room-1", "p1");

    assert.equal(
        session.findParticipant("p1").status,
        PAYMENT_PARTICIPANT_STATUS.BLOCKCHAIN_PENDING,
        "confirm intent waits for blockchain"
    );

    assert.equal(session.status, PAYMENT_SESSION_STATUS.ACTIVE);

    manager.confirmBlockchainPayment("room-1", "p1", { txHash: "tx1" });

    assert.equal(
        session.findParticipant("p1").status,
        PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED
    );

    manager.submitPlayerConfirmation("room-1", "p2");

    manager.confirmBlockchainPayment("room-1", "p2", { txHash: "tx2" });

    manager.submitPlayerConfirmation("room-1", "p3");

    manager.confirmBlockchainPayment("room-1", "p3", { txHash: "tx3" });

    assert.equal(session.status, PAYMENT_SESSION_STATUS.COMPLETED);

    assert.ok(
        updated.some((snap) => snap.status === PAYMENT_SESSION_STATUS.COMPLETED),
        "session updates include COMPLETED"
    );

    manager.destroySession("room-1");

    assert.equal(manager.getSession("room-1"), null);

    manager.shutdown();

    eventBus.shutdown();

}

{
    const { eventBus, manager } = createHarness({ durationMs: 20 });

    const failed = [];

    eventBus.subscribe(EVENT_TYPES.PAYMENT_SESSION_FAILED, (envelope) => {

        failed.push(envelope.payload);

    });

    manager.createAndRequest("room-1");

    await wait(40);

    assert.equal(failed.length, 1, "timeout emits PAYMENT_SESSION_FAILED");

    assert.equal(failed[0].reason, "payment_timeout");

    assert.equal(
        manager.getSession("room-1").status,
        PAYMENT_SESSION_STATUS.FAILED
    );

    manager.shutdown();

    eventBus.shutdown();

}

console.log("paymentSession.manager.test.js: all assertions passed");
