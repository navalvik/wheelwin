/**
 * R17.9L.7 — DepositMonitor architecture and blockchain observation test double tests.
 * NO real TON, NO smart contracts, NO GameContractManager integration.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DepositSessionCoordinator } from "../deposit/DepositSessionCoordinator.js";
import { DepositMonitor } from "../deposit/DepositMonitor.js";
import { DEPOSIT_OBSERVATION_STATUS } from "../deposit/DepositObservationStates.js";
import { TonFinancialDepositPersistence } from "../deposit/DepositPersistencePort.js";
import { TonFinancialDepositObservationPersistence } from "../deposit/DepositObservationPersistencePort.js";
import { FakeDepositBlockchainSource } from "../deposit/FakeDepositBlockchainSource.js";
import { DEPOSIT_SESSION_STATUS } from "../deposit/DepositSessionStates.js";
import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { TonFinancialPersistence } from "../persistence/TonFinancialPersistence.js";
import { TON_FINANCIAL_RECORD_TYPES } from "../persistence/TonFinancialRecordTypes.js";

function createLogger() {

    return {
        info() {},
        warn() {},
        error() {},
        debug() {},
        decisionTrace() {}
    };

}

function threePlayers() {

    return [
        { playerId: "p1", wallet: "EQ_wallet_1", expectedAmount: 10 },
        { playerId: "p2", wallet: "EQ_wallet_2", expectedAmount: 10 },
        { playerId: "p3", wallet: "EQ_wallet_3", expectedAmount: 10 }
    ];

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

    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-dmonitor-l7-"));

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

            emitted.push({ type, payload: envelope.payload });

        });

    }

    return emitted;

}

function createWatchableSession(coordinator, {
    roomId = "room-a",
    gameId = "game-a",
    depositAddress = "EQ_deposit_address",
    depositPersistence = null
} = {}) {

    const session = coordinator.createSession({ roomId, gameId });

    coordinator.bindPlayers(session.depositId, threePlayers());

    coordinator.markAwaitingFunds(session.depositId);

    session.depositAddress = depositAddress;

    if (depositPersistence) {

        depositPersistence.saveDepositSession(session);

    }

    return session;

}

function createHarness({ persistence = null } = {}) {

    const logger = createLogger();

    const eventBus = createEventBus(logger);

    const depositPersistence = persistence
        ? new TonFinancialDepositPersistence(persistence)
        : null;

    const depositSessionCoordinator = new DepositSessionCoordinator({
        eventBus,
        persistence: depositPersistence
    });

    const observationPersistence = persistence
        ? new TonFinancialDepositObservationPersistence(persistence)
        : null;

    const monitor = new DepositMonitor({
        logger,
        eventBus,
        depositSessionCoordinator,
        persistence: observationPersistence
    });

    monitor.initialize();

    const source = new FakeDepositBlockchainSource({ monitor });

    return {
        logger,
        eventBus,
        depositSessionCoordinator,
        monitor,
        source,
        persistence,
        depositPersistence
    };

}

test("R17.9L.7 Test1: valid observation accepted and emits DEPOSIT_SEAT_FUNDED", () => {

    const { monitor, source, depositSessionCoordinator, eventBus } = createHarness();

    const emitted = collectEvents(eventBus, [
        EVENT_TYPES.DEPOSIT_OBSERVATION_RECEIVED,
        EVENT_TYPES.DEPOSIT_SEAT_FUNDED,
        EVENT_TYPES.DEPOSIT_OBSERVATION_REJECTED,
        EVENT_TYPES.DEPOSIT_FULL_ONCHAIN
    ]);

    const session = createWatchableSession(depositSessionCoordinator);

    monitor.startWatching(session);

    const observation = source.emitValidPayment({
        depositId: session.depositId,
        depositAddress: session.depositAddress,
        senderWallet: "EQ_wallet_1",
        amount: 10,
        transactionHash: "tx-valid-1"
    });

    assert.equal(observation.observationStatus, DEPOSIT_OBSERVATION_STATUS.VALIDATED);

    assert.ok(emitted.some((entry) => entry.type === EVENT_TYPES.DEPOSIT_SEAT_FUNDED));

    assert.equal(
        emitted.filter((entry) => entry.type === EVENT_TYPES.DEPOSIT_OBSERVATION_REJECTED).length,
        0
    );

    assert.equal(
        emitted.filter((entry) => entry.type === EVENT_TYPES.DEPOSIT_FULL_ONCHAIN).length,
        0
    );

});

test("R17.9L.7 Test2: unknown wallet rejected", () => {

    const { monitor, source, depositSessionCoordinator, eventBus } = createHarness();

    const emitted = collectEvents(eventBus, [
        EVENT_TYPES.DEPOSIT_OBSERVATION_REJECTED,
        EVENT_TYPES.DEPOSIT_SEAT_FUNDED
    ]);

    const session = createWatchableSession(depositSessionCoordinator);

    monitor.startWatching(session);

    const observation = source.emitInvalidWallet({
        depositId: session.depositId,
        depositAddress: session.depositAddress,
        transactionHash: "tx-unknown-wallet"
    });

    assert.equal(observation.observationStatus, DEPOSIT_OBSERVATION_STATUS.REJECTED);

    assert.ok(emitted.some((entry) => entry.type === EVENT_TYPES.DEPOSIT_OBSERVATION_REJECTED));

    assert.equal(
        emitted.filter((entry) => entry.type === EVENT_TYPES.DEPOSIT_SEAT_FUNDED).length,
        0
    );

});

test("R17.9L.7 Test3: wrong amount rejected", () => {

    const { monitor, source, depositSessionCoordinator, eventBus } = createHarness();

    const emitted = collectEvents(eventBus, [EVENT_TYPES.DEPOSIT_OBSERVATION_REJECTED]);

    const session = createWatchableSession(depositSessionCoordinator);

    monitor.startWatching(session);

    const observation = source.emitWrongAmount({
        depositId: session.depositId,
        depositAddress: session.depositAddress,
        senderWallet: "EQ_wallet_1",
        amount: 5,
        transactionHash: "tx-wrong-amount"
    });

    assert.equal(observation.observationStatus, DEPOSIT_OBSERVATION_STATUS.REJECTED);

    assert.equal(emitted.length, 1);

});

test("R17.9L.7 Test4: duplicate transaction rejected", () => {

    const { monitor, source, depositSessionCoordinator, eventBus } = createHarness();

    const emitted = collectEvents(eventBus, [EVENT_TYPES.DEPOSIT_OBSERVATION_REJECTED]);

    const session = createWatchableSession(depositSessionCoordinator);

    monitor.startWatching(session);

    const first = source.emitValidPayment({
        depositId: session.depositId,
        depositAddress: session.depositAddress,
        senderWallet: "EQ_wallet_1",
        amount: 10,
        transactionHash: "tx-dup"
    });

    assert.equal(first.observationStatus, DEPOSIT_OBSERVATION_STATUS.VALIDATED);

    const duplicate = source.emitDuplicateTransaction(first);

    assert.equal(duplicate.observationStatus, DEPOSIT_OBSERVATION_STATUS.REJECTED);

    assert.equal(emitted.length, 1);

});

test("R17.9L.7 Test5: three valid observations emit DEPOSIT_FULL_ONCHAIN", () => {

    const { monitor, source, depositSessionCoordinator, eventBus } = createHarness();

    const emitted = collectEvents(eventBus, [
        EVENT_TYPES.DEPOSIT_SEAT_FUNDED,
        EVENT_TYPES.DEPOSIT_FULL_ONCHAIN,
        EVENT_TYPES.DEPOSIT_FULL
    ]);

    const session = createWatchableSession(depositSessionCoordinator, {
        roomId: "room-full",
        gameId: "game-full"
    });

    monitor.startWatching(session);

    source.emitFullDeposit({
        depositId: session.depositId,
        depositAddress: session.depositAddress,
        players: threePlayers()
    });

    assert.equal(
        emitted.filter((entry) => entry.type === EVENT_TYPES.DEPOSIT_SEAT_FUNDED).length,
        3
    );

    assert.equal(
        emitted.filter((entry) => entry.type === EVENT_TYPES.DEPOSIT_FULL_ONCHAIN).length,
        1
    );

    assert.equal(
        emitted.filter((entry) => entry.type === EVENT_TYPES.DEPOSIT_FULL).length,
        0
    );

    assert.equal(session.state, DEPOSIT_SESSION_STATUS.AWAITING_FUNDS);

});

test("R17.9L.7 Test6: restart recovery restores active watches", () => {

    const { dataDir, persistence } = createDiskPersistence();

    let depositId = null;

    let depositAddress = null;

    try {

        const firstHarness = createHarness({ persistence });

        const session = createWatchableSession(firstHarness.depositSessionCoordinator, {
            roomId: "room-restart",
            gameId: "game-restart",
            depositAddress: "EQ_restart_deposit",
            depositPersistence: firstHarness.depositPersistence
        });

        depositId = session.depositId;

        depositAddress = session.depositAddress;

        firstHarness.monitor.startWatching(session);

        assert.equal(firstHarness.monitor.listActiveWatches().length, 1);

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

        const logger = createLogger();

        const eventBus = createEventBus(logger);

        const depositSessionCoordinator = new DepositSessionCoordinator({
            eventBus,
            persistence: new TonFinancialDepositPersistence(secondPersistence)
        });

        depositSessionCoordinator.restoreActiveSessions();

        const monitor = new DepositMonitor({
            logger,
            eventBus,
            depositSessionCoordinator,
            persistence: new TonFinancialDepositObservationPersistence(secondPersistence)
        });

        monitor.initialize();

        const summary = monitor.restoreActiveWatches();

        assert.equal(summary.restored, 1);

        const watches = monitor.listActiveWatches();

        assert.equal(watches.length, 1);

        assert.equal(watches[0].depositId, depositId);

        assert.equal(watches[0].depositAddress, depositAddress);

    } finally {

        secondPersistence.shutdown({ checkpoint: false });

        TonFinancialPersistence.destroyStorage(dataDir);

    }

});

test("R17.9L.7 Test7: security isolation — no authorization, deploy, or DEPOSIT_FULL", () => {

    const { dataDir, persistence } = createDiskPersistence();

    try {

        const logger = createLogger();

        const eventBus = createEventBus(logger);

        const depositSessionCoordinator = new DepositSessionCoordinator({
            eventBus,
            persistence: new TonFinancialDepositPersistence(persistence)
        });

        const monitor = new DepositMonitor({
            logger,
            eventBus,
            depositSessionCoordinator,
            persistence: new TonFinancialDepositObservationPersistence(persistence)
        });

        monitor.initialize();

        const source = new FakeDepositBlockchainSource({ monitor });

        let deployEvents = 0;

        let authorizationEvents = 0;

        let depositFullEvents = 0;

        for (const type of [
            EVENT_TYPES.GAME_CONTRACT_DEPLOYED,
            EVENT_TYPES.GAME_CONTRACT_DEPLOY_FAILED,
            EVENT_TYPES.DEPLOY_AUTHORIZATION_CREATED,
            EVENT_TYPES.DEPLOY_AUTHORIZATION_VALID,
            EVENT_TYPES.DEPOSIT_FULL
        ]) {

            eventBus.subscribe(type, () => {

                if (type === EVENT_TYPES.DEPOSIT_FULL) {

                    depositFullEvents += 1;

                } else if (
                    type === EVENT_TYPES.DEPLOY_AUTHORIZATION_CREATED
                    || type === EVENT_TYPES.DEPLOY_AUTHORIZATION_VALID
                ) {

                    authorizationEvents += 1;

                } else {

                    deployEvents += 1;

                }

            });

        }

        const session = createWatchableSession(depositSessionCoordinator, {
            roomId: "room-isolation",
            gameId: "game-isolation",
            depositPersistence: new TonFinancialDepositPersistence(persistence)
        });

        monitor.startWatching(session);

        source.emitFullDeposit({
            depositId: session.depositId,
            depositAddress: session.depositAddress,
            players: threePlayers()
        });

        assert.equal(deployEvents, 0);

        assert.equal(authorizationEvents, 0);

        assert.equal(depositFullEvents, 0);

        assert.equal(session.state, DEPOSIT_SESSION_STATUS.AWAITING_FUNDS);

        assert.equal(persistence.listActiveDeploymentAuthorizations().length, 0);

        const observations = persistence.listDepositObservations(session.depositId);

        assert.equal(observations.length, 3);

        assert.equal(
            observations[0].recordType,
            TON_FINANCIAL_RECORD_TYPES.DEPOSIT_OBSERVATION
        );

    } finally {

        persistence.shutdown({ checkpoint: false });

        TonFinancialPersistence.destroyStorage(dataDir);

    }

});
