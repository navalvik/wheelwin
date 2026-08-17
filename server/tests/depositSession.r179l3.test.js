/**
 * R17.9L.3 — DepositSession state machine skeleton tests.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { DepositSession } from "../deposit/DepositSession.js";
import { DepositSessionCoordinator } from "../deposit/DepositSessionCoordinator.js";
import {
    InvalidDepositBindingError,
    InvalidDepositFundingError,
    InvalidDepositIdentityError,
    InvalidDepositStateTransitionError
} from "../deposit/DepositSessionErrors.js";
import { InMemoryDepositPersistence } from "../deposit/DepositPersistencePort.js";
import { DEPOSIT_SESSION_STATUS } from "../deposit/DepositSessionStates.js";
import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { TON_FINANCIAL_RECORD_TYPES } from "../persistence/TonFinancialRecordTypes.js";
import { LoggerService } from "../services/LoggerService.js";

function threePlayers() {

    return [
        { playerId: "p1", wallet: "EQ_wallet_1", expectedAmount: 10 },
        { playerId: "p2", wallet: "EQ_wallet_2", expectedAmount: 10 },
        { playerId: "p3", wallet: "EQ_wallet_3", expectedAmount: 10 }
    ];

}

function fundAll(session) {

    session.applyFunding({ wallet: "EQ_wallet_1", amount: 10, fundingEventId: "tx-1" });
    session.applyFunding({ wallet: "EQ_wallet_2", amount: 10, fundingEventId: "tx-2" });
    session.applyFunding({ wallet: "EQ_wallet_3", amount: 10, fundingEventId: "tx-3" });

}

test("R17.9L.3 creates a valid DepositSession", () => {

    const session = new DepositSession({
        roomId: "room-a",
        gameId: "game-a"
    });

    assert.equal(session.state, DEPOSIT_SESSION_STATUS.CREATED);
    assert.equal(session.roomId, "room-a");
    assert.equal(session.gameId, "game-a");
    assert.ok(session.depositId);
    assert.equal(session.toRecord().recordType, TON_FINANCIAL_RECORD_TYPES.DEPOSIT_SESSION);

});

test("R17.9L.3 rejects invalid roomId", () => {

    assert.throws(
        () => new DepositSession({ roomId: "", gameId: "game-a" }),
        (error) => error instanceof InvalidDepositIdentityError
    );

    assert.throws(
        () => new DepositSession({ roomId: null, gameId: "game-a" }),
        (error) => error instanceof InvalidDepositIdentityError
    );

});

test("R17.9L.3 rejects invalid gameId", () => {

    assert.throws(
        () => new DepositSession({ roomId: "room-a", gameId: "  " }),
        (error) => error instanceof InvalidDepositIdentityError
    );

    const coordinator = new DepositSessionCoordinator({
        roomExists: () => true,
        gameExists: () => false
    });

    assert.throws(
        () => coordinator.createSession({ roomId: "room-a", gameId: "missing-game" }),
        (error) => error instanceof InvalidDepositIdentityError
    );

});

test("R17.9L.3 accepts exactly 3 unique wallets", () => {

    const session = new DepositSession({ roomId: "room-b", gameId: "game-b" });

    session.bindPlayers(threePlayers());

    assert.equal(session.state, DEPOSIT_SESSION_STATUS.PLAYER_BINDING);
    assert.equal(session.bindings.length, 3);

});

test("R17.9L.3 rejects duplicate wallets", () => {

    const session = new DepositSession({ roomId: "room-c", gameId: "game-c" });

    assert.throws(
        () => session.bindPlayers([
            { playerId: "p1", wallet: "EQ_same", expectedAmount: 10 },
            { playerId: "p2", wallet: "EQ_same", expectedAmount: 10 },
            { playerId: "p3", wallet: "EQ_other", expectedAmount: 10 }
        ]),
        (error) => error instanceof InvalidDepositBindingError
    );

});

test("R17.9L.3 rejects wrong player count", () => {

    const session = new DepositSession({ roomId: "room-d", gameId: "game-d" });

    assert.throws(
        () => session.bindPlayers([
            { playerId: "p1", wallet: "EQ_1", expectedAmount: 10 },
            { playerId: "p2", wallet: "EQ_2", expectedAmount: 10 }
        ]),
        (error) => error instanceof InvalidDepositBindingError
    );

    assert.throws(
        () => session.bindPlayers([
            ...threePlayers(),
            { playerId: "p4", wallet: "EQ_4", expectedAmount: 10 }
        ]),
        (error) => error instanceof InvalidDepositBindingError
    );

});

test("R17.9L.3 valid path CREATED to DEPOSIT_FULL", () => {

    const session = new DepositSession({ roomId: "room-e", gameId: "game-e" });

    session.bindPlayers(threePlayers());
    session.markAwaitingFunds();

    assert.equal(session.state, DEPOSIT_SESSION_STATUS.AWAITING_FUNDS);

    session.applyFunding({ wallet: "EQ_wallet_1", amount: 10, fundingEventId: "tx-1" });

    assert.equal(session.state, DEPOSIT_SESSION_STATUS.PARTIALLY_FUNDED);

    session.applyFunding({ wallet: "EQ_wallet_2", amount: 10, fundingEventId: "tx-2" });

    assert.equal(session.state, DEPOSIT_SESSION_STATUS.PARTIALLY_FUNDED);

    session.applyFunding({ wallet: "EQ_wallet_3", amount: 10, fundingEventId: "tx-3" });

    assert.equal(session.state, DEPOSIT_SESSION_STATUS.DEPOSIT_FULL);
    assert.equal(session.isFullyFunded(), true);

});

test("R17.9L.3 rejects CREATED to DEPOSIT_FULL", () => {

    const session = new DepositSession({ roomId: "room-f", gameId: "game-f" });

    assert.throws(
        () => session.transitionTo(DEPOSIT_SESSION_STATUS.DEPOSIT_FULL),
        (error) => error instanceof InvalidDepositStateTransitionError
    );

});

test("R17.9L.3 rejects REFUNDED to AWAITING_FUNDS", () => {

    const session = new DepositSession({ roomId: "room-g", gameId: "game-g" });

    session.bindPlayers(threePlayers());
    session.markAwaitingFunds();
    session.expire();
    session.startRefund();
    session.completeRefund();

    assert.equal(session.state, DEPOSIT_SESSION_STATUS.REFUNDED);
    assert.equal(session.isTerminal(), true);

    assert.throws(
        () => session.transitionTo(DEPOSIT_SESSION_STATUS.AWAITING_FUNDS),
        (error) => error instanceof InvalidDepositStateTransitionError
    );

    assert.throws(
        () => session.transitionTo(DEPOSIT_SESSION_STATUS.DEPOSIT_FULL),
        (error) => error instanceof InvalidDepositStateTransitionError
    );

});

test("R17.9L.3 rejects PARTIALLY_FUNDED to GAME_CONTRACT_CREATED", () => {

    const session = new DepositSession({ roomId: "room-h", gameId: "game-h" });

    session.bindPlayers(threePlayers());
    session.markAwaitingFunds();
    session.applyFunding({ wallet: "EQ_wallet_1", amount: 10, fundingEventId: "tx-1" });

    assert.throws(
        () => session.transitionTo(DEPOSIT_SESSION_STATUS.GAME_CONTRACT_CREATED),
        (error) => error instanceof InvalidDepositStateTransitionError
    );

});

test("R17.9L.3 funding rejects overpayment, unknown wallet, and duplicates", () => {

    const session = new DepositSession({ roomId: "room-i", gameId: "game-i" });

    session.bindPlayers(threePlayers());
    session.markAwaitingFunds();

    assert.throws(
        () => session.applyFunding({
            wallet: "EQ_wallet_1",
            amount: 11,
            fundingEventId: "tx-over"
        }),
        (error) => error instanceof InvalidDepositFundingError
    );

    assert.throws(
        () => session.applyFunding({
            wallet: "EQ_unknown",
            amount: 10,
            fundingEventId: "tx-unknown"
        }),
        (error) => error instanceof InvalidDepositFundingError
    );

    session.applyFunding({ wallet: "EQ_wallet_1", amount: 10, fundingEventId: "tx-1" });

    assert.throws(
        () => session.applyFunding({
            wallet: "EQ_wallet_1",
            amount: 10,
            fundingEventId: "tx-1-again"
        }),
        (error) => error instanceof InvalidDepositFundingError
    );

    assert.throws(
        () => session.applyFunding({
            wallet: "EQ_wallet_2",
            amount: 10,
            fundingEventId: "tx-1"
        }),
        (error) => error instanceof InvalidDepositFundingError
    );

    assert.equal(session.state, DEPOSIT_SESSION_STATUS.PARTIALLY_FUNDED);

});

test("R17.9L.3 serialize and restore preserves state", async () => {

    const persistence = new InMemoryDepositPersistence();
    const session = new DepositSession({ roomId: "room-j", gameId: "game-j" });

    session.bindPlayers(threePlayers());
    session.markAwaitingFunds();
    fundAll(session);

    assert.equal(session.state, DEPOSIT_SESSION_STATUS.DEPOSIT_FULL);

    await persistence.saveDepositSession(session);

    const record = await persistence.loadDepositSession(session.depositId);
    const restored = DepositSession.fromRecord(record);

    assert.equal(restored.depositId, session.depositId);
    assert.equal(restored.roomId, "room-j");
    assert.equal(restored.gameId, "game-j");
    assert.equal(restored.state, DEPOSIT_SESSION_STATUS.DEPOSIT_FULL);
    assert.equal(restored.bindings.length, 3);
    assert.equal(restored.bindings.every((binding) => binding.funded), true);
    assert.deepEqual(restored.fundingEventIds, ["tx-1", "tx-2", "tx-3"]);

    const byKey = await persistence.loadByRoomAndGame("room-j", "game-j");

    assert.equal(byKey.recordId, session.depositId);

});

test("R17.9L.3 coordinator emits domain events and restoreFromPersistence", async () => {

    const logger = new LoggerService();

    logger.initialize();

    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    const emitted = [];

    for (const type of [
        EVENT_TYPES.DEPOSIT_CREATED,
        EVENT_TYPES.DEPOSIT_PLAYER_BOUND,
        EVENT_TYPES.DEPOSIT_STATE_CHANGED,
        EVENT_TYPES.DEPOSIT_FULL,
        EVENT_TYPES.DEPOSIT_EXPIRED,
        EVENT_TYPES.DEPOSIT_REFUND_STARTED,
        EVENT_TYPES.DEPOSIT_REFUNDED
    ]) {

        eventBus.subscribe(type, (envelope) => {

            emitted.push(envelope.type);

        });

    }

    const persistence = new InMemoryDepositPersistence();
    const coordinator = new DepositSessionCoordinator({ eventBus, persistence });
    const session = coordinator.createSession({ roomId: "room-k", gameId: "game-k" });

    coordinator.bindPlayers(session.depositId, threePlayers());
    coordinator.markAwaitingFunds(session.depositId);
    coordinator.applyFunding(session.depositId, {
        wallet: "EQ_wallet_1",
        amount: 10,
        fundingEventId: "tx-1"
    });
    coordinator.applyFunding(session.depositId, {
        wallet: "EQ_wallet_2",
        amount: 10,
        fundingEventId: "tx-2"
    });
    coordinator.applyFunding(session.depositId, {
        wallet: "EQ_wallet_3",
        amount: 10,
        fundingEventId: "tx-3"
    });

    assert.equal(session.state, DEPOSIT_SESSION_STATUS.DEPOSIT_FULL);
    assert.ok(emitted.includes(EVENT_TYPES.DEPOSIT_CREATED));
    assert.ok(emitted.includes(EVENT_TYPES.DEPOSIT_PLAYER_BOUND));
    assert.ok(emitted.includes(EVENT_TYPES.DEPOSIT_FULL));
    assert.ok(emitted.includes(EVENT_TYPES.DEPOSIT_STATE_CHANGED));

    coordinator.authorizeDeploy(session.depositId);
    coordinator.markGameContractCreated(session.depositId);
    coordinator.release(session.depositId);

    assert.equal(session.state, DEPOSIT_SESSION_STATUS.RELEASED);

    const restored = await coordinator.restoreFromPersistence(session.depositId);

    assert.equal(restored.state, DEPOSIT_SESSION_STATUS.RELEASED);

    const refundSession = coordinator.createSession({
        roomId: "room-k2",
        gameId: "game-k2"
    });

    coordinator.bindPlayers(refundSession.depositId, threePlayers());
    coordinator.markAwaitingFunds(refundSession.depositId);
    coordinator.expire(refundSession.depositId);
    coordinator.startRefund(refundSession.depositId);
    coordinator.completeRefund(refundSession.depositId);

    assert.equal(refundSession.state, DEPOSIT_SESSION_STATUS.REFUNDED);
    assert.ok(emitted.includes(EVENT_TYPES.DEPOSIT_EXPIRED));
    assert.ok(emitted.includes(EVENT_TYPES.DEPOSIT_REFUND_STARTED));
    assert.ok(emitted.includes(EVENT_TYPES.DEPOSIT_REFUNDED));

    eventBus.shutdown();

});

console.log("depositSession.r179l3.test.js: all assertions passed");
