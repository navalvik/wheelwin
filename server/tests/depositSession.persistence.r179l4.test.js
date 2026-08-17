/**
 * R17.9L.4 — DepositSession durable persistence and restart recovery tests.
 * No TON, no DepositMonitor, no deployment authorization, no GameContract deploy.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DepositSessionCoordinator } from "../deposit/DepositSessionCoordinator.js";
import { InMemoryDepositPersistence, TonFinancialDepositPersistence } from "../deposit/DepositPersistencePort.js";
import { DEPOSIT_SESSION_STATUS } from "../deposit/DepositSessionStates.js";
import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { TonFinancialPersistence } from "../persistence/TonFinancialPersistence.js";
import { TON_FINANCIAL_RECORD_TYPES } from "../persistence/TonFinancialRecordTypes.js";
import { TonFinancialRecovery } from "../recovery/TonFinancialRecovery.js";
import { LoggerService } from "../services/LoggerService.js";

function threePlayers() {

    return [
        { playerId: "p1", wallet: "EQ_wallet_1", expectedAmount: 10 },
        { playerId: "p2", wallet: "EQ_wallet_2", expectedAmount: 10 },
        { playerId: "p3", wallet: "EQ_wallet_3", expectedAmount: 10 }
    ];

}

function createLogger() {

    const logger = new LoggerService();

    logger.initialize();

    return logger;

}

function createEventBus(logger) {

    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    return eventBus;

}

function createDiskPersistence() {

    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-deposit-l4-"));

    const persistence = new TonFinancialPersistence({
        dataDir,
        autoCheckpoint: false
    });

    persistence.initialize();

    return { dataDir, persistence };

}

function reopenPersistence(dataDir) {

    const persistence = new TonFinancialPersistence({
        dataDir,
        autoCheckpoint: false
    });

    persistence.initialize();

    return persistence;

}

function collectEvents(eventBus, types) {

    const emitted = [];

    for (const type of types) {

        eventBus.subscribe(type, (envelope) => {

            emitted.push(envelope.type);

        });

    }

    return emitted;

}

function assertSessionMatches(actual, expected) {

    assert.equal(actual.depositId, expected.depositId);
    assert.equal(actual.roomId, expected.roomId);
    assert.equal(actual.gameId, expected.gameId);
    assert.equal(actual.state, expected.state);
    assert.equal(actual.bindings.length, expected.bindings.length);
    assert.deepEqual(
        actual.bindings.map((binding) => ({
            playerId: binding.playerId,
            wallet: binding.wallet,
            expectedAmount: binding.expectedAmount,
            receivedAmount: binding.receivedAmount,
            funded: binding.funded,
            fundingEventId: binding.fundingEventId
        })),
        expected.bindings.map((binding) => ({
            playerId: binding.playerId,
            wallet: binding.wallet,
            expectedAmount: binding.expectedAmount,
            receivedAmount: binding.receivedAmount,
            funded: binding.funded,
            fundingEventId: binding.fundingEventId
        }))
    );
    assert.deepEqual(actual.fundingEventIds, expected.fundingEventIds);
    assert.equal(actual.expiresAt, expected.expiresAt);
    assert.equal(actual.depositAddress, expected.depositAddress);
    assert.equal(actual.bindingHash, expected.bindingHash);
    assert.equal(actual.authorizationHash, expected.authorizationHash);
}

test("R17.9L.4 save/load preserves state, wallets, and amounts", () => {

    const { dataDir, persistence } = createDiskPersistence();

    try {

        const adapter = new TonFinancialDepositPersistence(persistence);
        const coordinator = new DepositSessionCoordinator({ persistence: adapter });

        const session = coordinator.createSession({
            roomId: "room-save",
            gameId: "game-save",
            metadata: { depositTimeoutMs: 60_000, note: "durable" }
        });

        coordinator.bindPlayers(session.depositId, threePlayers());
        coordinator.markAwaitingFunds(session.depositId);
        coordinator.applyFunding(session.depositId, {
            wallet: "EQ_wallet_1",
            amount: 10,
            fundingEventId: "tx-1"
        });

        const loaded = persistence.loadDepositSession(session.depositId);

        assert.equal(loaded.recordType, TON_FINANCIAL_RECORD_TYPES.DEPOSIT_SESSION);
        assert.equal(loaded.recordId, session.depositId);
        assert.equal(loaded.status, DEPOSIT_SESSION_STATUS.PARTIALLY_FUNDED);
        assert.equal(loaded.payload.state, DEPOSIT_SESSION_STATUS.PARTIALLY_FUNDED);
        assert.equal(loaded.payload.bindings[0].wallet, "EQ_wallet_1");
        assert.equal(loaded.payload.bindings[0].expectedAmount, 10);
        assert.equal(loaded.payload.bindings[0].receivedAmount, 10);
        assert.equal(loaded.payload.bindings[0].funded, true);
        assert.equal(loaded.payload.bindings[1].funded, false);
        assert.equal(loaded.payload.expiresAt, session.expiresAt);
        assert.ok(loaded.payload.bindingHash);
        assert.equal(loaded.payload.depositAddress, null);
        assert.equal(loaded.payload.authorizationHash, null);
        assert.equal(loaded.payload.metadata.note, "durable");

        const listed = persistence.listActiveDepositSessions();

        assert.equal(listed.length, 1);
        assert.equal(listed[0].recordId, session.depositId);

        persistence.removeDepositSession(session.depositId);

        assert.equal(persistence.listActiveDepositSessions().length, 0);

    } finally {

        persistence.shutdown({ checkpoint: false });
        TonFinancialPersistence.destroyStorage(dataDir);

    }

});

test("R17.9L.4 restart simulation restores an identical session", () => {

    const { dataDir, persistence } = createDiskPersistence();

    let snapshot = null;
    let depositId = null;

    try {

        const first = new DepositSessionCoordinator({
            persistence: new TonFinancialDepositPersistence(persistence)
        });

        const session = first.createSession({
            roomId: "room-restart",
            gameId: "game-restart",
            metadata: { depositTimeoutMs: 120_000 }
        });

        first.bindPlayers(session.depositId, threePlayers());
        first.markAwaitingFunds(session.depositId);
        first.applyFunding(session.depositId, {
            wallet: "EQ_wallet_2",
            amount: 10,
            fundingEventId: "tx-2"
        });

        depositId = session.depositId;
        snapshot = session.toPayload();

        persistence.shutdown({ checkpoint: false });

    } finally {

        try {

            persistence.shutdown({ checkpoint: false });

        } catch {

            // already shut down

        }

    }

    const secondPersistence = reopenPersistence(dataDir);

    try {

        const second = new DepositSessionCoordinator({
            persistence: new TonFinancialDepositPersistence(secondPersistence)
        });

        assert.equal(second.getSession(depositId), null);

        const summary = second.restoreActiveSessions();

        assert.equal(summary.restored, 1);

        const restored = second.getSession(depositId);

        assert.ok(restored);
        assertSessionMatches(restored, snapshot);
        assert.equal(restored.state, DEPOSIT_SESSION_STATUS.PARTIALLY_FUNDED);
        assert.equal(restored.bindings[1].funded, true);
        assert.equal(restored.bindings[0].funded, false);

    } finally {

        secondPersistence.shutdown({ checkpoint: false });
        TonFinancialPersistence.destroyStorage(dataDir);

    }

});

test("R17.9L.4 restores AWAITING_FUNDS, PARTIALLY_FUNDED, and DEPOSIT_FULL", () => {

    const { dataDir, persistence } = createDiskPersistence();

    const adapter = new TonFinancialDepositPersistence(persistence);
    const first = new DepositSessionCoordinator({ persistence: adapter });

    const awaiting = first.createSession({ roomId: "room-await", gameId: "game-await" });
    first.bindPlayers(awaiting.depositId, threePlayers());
    first.markAwaitingFunds(awaiting.depositId);

    const partial = first.createSession({ roomId: "room-partial", gameId: "game-partial" });
    first.bindPlayers(partial.depositId, threePlayers());
    first.markAwaitingFunds(partial.depositId);
    first.applyFunding(partial.depositId, {
        wallet: "EQ_wallet_1",
        amount: 10,
        fundingEventId: "tx-p1"
    });

    const full = first.createSession({ roomId: "room-full", gameId: "game-full" });
    first.bindPlayers(full.depositId, threePlayers());
    first.markAwaitingFunds(full.depositId);
    first.applyFunding(full.depositId, {
        wallet: "EQ_wallet_1",
        amount: 10,
        fundingEventId: "tx-f1"
    });
    first.applyFunding(full.depositId, {
        wallet: "EQ_wallet_2",
        amount: 10,
        fundingEventId: "tx-f2"
    });
    first.applyFunding(full.depositId, {
        wallet: "EQ_wallet_3",
        amount: 10,
        fundingEventId: "tx-f3"
    });

    persistence.shutdown({ checkpoint: false });

    const secondPersistence = reopenPersistence(dataDir);

    try {

        const second = new DepositSessionCoordinator({
            persistence: new TonFinancialDepositPersistence(secondPersistence)
        });

        second.restoreActiveSessions();

        assert.equal(
            second.getSession(awaiting.depositId).state,
            DEPOSIT_SESSION_STATUS.AWAITING_FUNDS
        );
        assert.equal(
            second.getSession(partial.depositId).state,
            DEPOSIT_SESSION_STATUS.PARTIALLY_FUNDED
        );
        assert.equal(
            second.getSession(full.depositId).state,
            DEPOSIT_SESSION_STATUS.DEPOSIT_FULL
        );

        second.applyFunding(awaiting.depositId, {
            wallet: "EQ_wallet_1",
            amount: 10,
            fundingEventId: "tx-a1"
        });

        assert.equal(
            second.getSession(awaiting.depositId).state,
            DEPOSIT_SESSION_STATUS.PARTIALLY_FUNDED
        );

        second.applyFunding(partial.depositId, {
            wallet: "EQ_wallet_2",
            amount: 10,
            fundingEventId: "tx-p2"
        });
        second.applyFunding(partial.depositId, {
            wallet: "EQ_wallet_3",
            amount: 10,
            fundingEventId: "tx-p3"
        });

        assert.equal(
            second.getSession(partial.depositId).state,
            DEPOSIT_SESSION_STATUS.DEPOSIT_FULL
        );
        assert.equal(second.getSession(partial.depositId).bindings.every((binding) => binding.funded), true);

    } finally {

        secondPersistence.shutdown({ checkpoint: false });
        TonFinancialPersistence.destroyStorage(dataDir);

    }

});

test("R17.9L.4 restoring DEPOSIT_FULL does not deploy or emit authorization", async () => {

    const { dataDir, persistence } = createDiskPersistence();
    const logger = createLogger();
    const eventBus = createEventBus(logger);

    const emitted = collectEvents(eventBus, [
        EVENT_TYPES.DEPOSIT_FULL,
        EVENT_TYPES.DEPOSIT_CREATED,
        EVENT_TYPES.DEPOSIT_STATE_CHANGED,
        EVENT_TYPES.GAME_CONTRACT_DEPLOYED,
        EVENT_TYPES.GAME_CONTRACT_UPDATED
    ]);

    const beginDeployCalls = [];

    const gameContractManager = {
        restoreGameContracts() {

            return { restored: 0 };

        },
        _beginDeploy(payload) {

            beginDeployCalls.push(payload);

        }
    };

    try {

        const writer = new DepositSessionCoordinator({
            persistence: new TonFinancialDepositPersistence(persistence)
        });

        const session = writer.createSession({ roomId: "room-full-safe", gameId: "game-full-safe" });

        writer.bindPlayers(session.depositId, threePlayers());
        writer.markAwaitingFunds(session.depositId);
        writer.applyFunding(session.depositId, {
            wallet: "EQ_wallet_1",
            amount: 10,
            fundingEventId: "tx-s1"
        });
        writer.applyFunding(session.depositId, {
            wallet: "EQ_wallet_2",
            amount: 10,
            fundingEventId: "tx-s2"
        });
        writer.applyFunding(session.depositId, {
            wallet: "EQ_wallet_3",
            amount: 10,
            fundingEventId: "tx-s3"
        });

        assert.equal(session.state, DEPOSIT_SESSION_STATUS.DEPOSIT_FULL);

        persistence.shutdown({ checkpoint: false });

        const secondPersistence = reopenPersistence(dataDir);

        try {

            const restoredCoordinator = new DepositSessionCoordinator({
                eventBus,
                persistence: new TonFinancialDepositPersistence(secondPersistence)
            });

            const recovery = new TonFinancialRecovery({
                logger,
                eventBus,
                financialPersistence: secondPersistence,
                depositSessionCoordinator: restoredCoordinator,
                gameContractManager
            });

            recovery.initialize();

            const report = await recovery.recover({
                trigger: "server_restart",
                reason: "deposit_full_safety"
            });

            const restored = restoredCoordinator.getSession(session.depositId);

            assert.equal(restored.state, DEPOSIT_SESSION_STATUS.DEPOSIT_FULL);
            assert.equal(restored.authorizationHash, null);
            assert.equal(beginDeployCalls.length, 0);
            assert.equal(
                secondPersistence.listActive(TON_FINANCIAL_RECORD_TYPES.GAME_CONTRACT).length,
                0
            );
            assert.equal(emitted.includes(EVENT_TYPES.DEPOSIT_FULL), false);
            assert.equal(emitted.includes(EVENT_TYPES.GAME_CONTRACT_DEPLOYED), false);
            assert.ok(report.warnings.some((warning) => warning.startsWith("deposit_restore:restored=1")));

        } finally {

            secondPersistence.shutdown({ checkpoint: false });

        }

    } finally {

        eventBus.shutdown();
        TonFinancialPersistence.destroyStorage(dataDir);

    }

});

test("R17.9L.4 persist failure throws and does not emit success events", () => {

    const logger = createLogger();
    const eventBus = createEventBus(logger);
    const emitted = collectEvents(eventBus, [
        EVENT_TYPES.DEPOSIT_CREATED,
        EVENT_TYPES.DEPOSIT_PLAYER_BOUND,
        EVENT_TYPES.DEPOSIT_STATE_CHANGED
    ]);

    class FailingCreatePersistence extends InMemoryDepositPersistence {

        saveDepositSession() {

            throw new Error("disk full");

        }

    }

    const createCoordinator = new DepositSessionCoordinator({
        eventBus,
        persistence: new FailingCreatePersistence()
    });

    assert.throws(
        () => createCoordinator.createSession({ roomId: "room-fail", gameId: "game-fail" }),
        /disk full/
    );

    assert.equal(createCoordinator.getByRoomAndGame("room-fail", "game-fail"), null);
    assert.equal(emitted.length, 0);

    class FailAfterCreatePersistence extends InMemoryDepositPersistence {

        constructor() {

            super();

            this.saves = 0;

        }

        saveDepositSession(session) {

            this.saves += 1;

            if (this.saves > 1) {

                throw new Error("disk full");

            }

            return super.saveDepositSession(session);

        }

    }

    const bindCoordinator = new DepositSessionCoordinator({
        eventBus,
        persistence: new FailAfterCreatePersistence()
    });

    const session = bindCoordinator.createSession({
        roomId: "room-bind-fail",
        gameId: "game-bind-fail"
    });

    assert.equal(session.state, DEPOSIT_SESSION_STATUS.CREATED);
    assert.ok(emitted.includes(EVENT_TYPES.DEPOSIT_CREATED));

    const afterCreate = emitted.length;

    assert.throws(
        () => bindCoordinator.bindPlayers(session.depositId, threePlayers()),
        /disk full/
    );

    assert.equal(session.state, DEPOSIT_SESSION_STATUS.CREATED);
    assert.equal(session.bindings.length, 0);
    assert.equal(emitted.includes(EVENT_TYPES.DEPOSIT_PLAYER_BOUND), false);
    assert.equal(emitted.length, afterCreate);

    eventBus.shutdown();

});

test("R17.9L.4 does not auto-restore terminal deposit sessions", () => {

    const persistence = new InMemoryDepositPersistence();
    const first = new DepositSessionCoordinator({ persistence });

    const released = first.createSession({ roomId: "room-term", gameId: "game-term" });

    first.bindPlayers(released.depositId, threePlayers());
    first.markAwaitingFunds(released.depositId);
    first.applyFunding(released.depositId, {
        wallet: "EQ_wallet_1",
        amount: 10,
        fundingEventId: "tx-t1"
    });
    first.applyFunding(released.depositId, {
        wallet: "EQ_wallet_2",
        amount: 10,
        fundingEventId: "tx-t2"
    });
    first.applyFunding(released.depositId, {
        wallet: "EQ_wallet_3",
        amount: 10,
        fundingEventId: "tx-t3"
    });
    first.authorizeDeploy(released.depositId);
    first.markGameContractCreated(released.depositId);
    first.release(released.depositId);

    const refunded = first.createSession({ roomId: "room-ref", gameId: "game-ref" });

    first.bindPlayers(refunded.depositId, threePlayers());
    first.markAwaitingFunds(refunded.depositId);
    first.expire(refunded.depositId);
    first.startRefund(refunded.depositId);
    first.completeRefund(refunded.depositId);

    const second = new DepositSessionCoordinator({ persistence });
    const summary = second.restoreActiveSessions();

    assert.equal(summary.restored, 0);
    assert.equal(summary.skipped, 2);
    assert.equal(second.getSession(released.depositId), null);
    assert.equal(second.getSession(refunded.depositId), null);

});

console.log("depositSession.persistence.r179l4.test.js: all assertions passed");
