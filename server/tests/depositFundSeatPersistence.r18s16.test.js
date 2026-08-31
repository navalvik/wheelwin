/**
 * R18-S16 — Incremental FundSeat persistence + isolated setup timeout.
 * Fake observations only. No real TON. No GameEscrow. No Page4.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { DepositSessionCoordinator } from "../deposit/DepositSessionCoordinator.js";
import { DepositMonitor } from "../deposit/DepositMonitor.js";
import { DepositOnChainVerificationCoordinator } from "../deposit/DepositOnChainVerificationCoordinator.js";
import { FakeDepositBlockchainSource } from "../deposit/FakeDepositBlockchainSource.js";
import { TonFinancialDepositPersistence } from "../deposit/DepositPersistencePort.js";
import { TonFinancialDepositObservationPersistence } from "../deposit/DepositObservationPersistencePort.js";
import { DEPOSIT_SESSION_STATUS } from "../deposit/DepositSessionStates.js";
import { DEPOSIT_OBSERVATION_STATUS } from "../deposit/DepositObservationStates.js";
import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { EVENT_SOURCES } from "../events/EventSources.js";
import { TonFinancialPersistence } from "../persistence/TonFinancialPersistence.js";
import { loadRoomConfig } from "../config/rooms.js";

const SERVER_ROOT = dirname(fileURLToPath(import.meta.url));
const DEPOSIT_ADDRESS = "EQAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBMWg";
const EIGHT_MIN_MS = 8 * 60 * 1000;
const FIVE_MIN_MS = 5 * 60 * 1000;

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
        { playerId: "p1", wallet: "EQ_wallet_1", expectedAmount: 11000000 },
        { playerId: "p2", wallet: "EQ_wallet_2", expectedAmount: 11000000 },
        { playerId: "p3", wallet: "EQ_wallet_3", expectedAmount: 11000000 }
    ];

}

function paidMask(session) {

    return session.bindings.reduce(
        (mask, binding, index) => mask | (binding.funded === true ? (1 << index) : 0),
        0
    );

}

function totalCredited(session) {

    return session.bindings.reduce(
        (sum, binding) => sum + Number(binding.receivedAmount || 0),
        0
    );

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

    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-r18s16-fs-"));

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

function createHarness({ persistence }) {

    const logger = createLogger();
    const eventBus = createEventBus(logger);
    const depositPersistence = new TonFinancialDepositPersistence(persistence);
    const observationPersistence = new TonFinancialDepositObservationPersistence(persistence);

    const depositSessionCoordinator = new DepositSessionCoordinator({
        eventBus,
        persistence: depositPersistence
    });

    const monitor = new DepositMonitor({
        logger,
        eventBus,
        depositSessionCoordinator,
        persistence: observationPersistence
    });

    monitor.initialize();

    const verificationCoordinator = new DepositOnChainVerificationCoordinator({
        logger,
        eventBus,
        depositSessionCoordinator,
        observationPersistence
    });

    verificationCoordinator.initialize();

    const source = new FakeDepositBlockchainSource({ monitor });

    return {
        logger,
        eventBus,
        depositSessionCoordinator,
        monitor,
        verificationCoordinator,
        source,
        persistence,
        depositPersistence,
        observationPersistence
    };

}

function createWatchableSession(coordinator, depositPersistence) {

    const session = coordinator.createSession({
        roomId: "room-sZqc-model",
        gameId: "game-sZqc-model"
    });

    coordinator.bindPlayers(session.depositId, threePlayers());
    coordinator.markAwaitingFunds(session.depositId);
    coordinator.setDepositAddress(session.depositId, DEPOSIT_ADDRESS);
    depositPersistence.saveDepositSession(session);

    return session;

}

function fundSeat(h, session, { wallet, tx, amount = 11000000 }) {

    return h.source.emitValidPayment({
        depositId: session.depositId,
        depositAddress: DEPOSIT_ADDRESS,
        senderWallet: wallet,
        amount,
        transactionHash: tx
    });

}

test("R18-S16: one FundSeat updates the matching DepositSession seat and persists", () => {

    const { dataDir, persistence } = createDiskPersistence();
    const h = createHarness({ persistence });
    const session = createWatchableSession(
        h.depositSessionCoordinator,
        h.depositPersistence
    );

    h.monitor.startWatching(session);

    const observation = fundSeat(h, session, { wallet: "EQ_wallet_2", tx: "tx-lena" });

    assert.equal(observation.observationStatus, DEPOSIT_OBSERVATION_STATUS.VALIDATED);
    assert.equal(observation.depositId, session.depositId);

    const live = h.depositSessionCoordinator.getSession(session.depositId);

    assert.equal(live.depositId, session.depositId);
    assert.equal(live.roomId, "room-sZqc-model");
    assert.equal(live.bindings[1].wallet, "EQ_wallet_2");
    assert.equal(live.bindings[1].funded, true);
    assert.equal(live.bindings[1].receivedAmount, 11000000);
    assert.equal(live.bindings[0].funded, false);
    assert.equal(live.bindings[2].funded, false);
    assert.equal(paidMask(live), 0b010);
    assert.equal(totalCredited(live), 11000000);
    assert.equal(live.state, DEPOSIT_SESSION_STATUS.PARTIALLY_FUNDED);

    const persistence2 = reopenPersistence(dataDir);
    const coordinator2 = new DepositSessionCoordinator({
        eventBus: createEventBus(createLogger()),
        persistence: new TonFinancialDepositPersistence(persistence2)
    });

    const restored = coordinator2.restoreFromPersistence(session.depositId);

    assert.equal(restored.state, DEPOSIT_SESSION_STATUS.PARTIALLY_FUNDED);
    assert.equal(restored.bindings[1].funded, true);
    assert.equal(restored.bindings[1].receivedAmount, 11000000);
    assert.equal(restored.bindings[0].funded, false);
    assert.equal(paidMask(restored), 0b010);
    assert.equal(totalCredited(restored), 11000000);

});

test("R18-S16: two FundSeats remain PARTIALLY_FUNDED; third reaches DEPOSIT_FULL", () => {

    const { dataDir, persistence } = createDiskPersistence();
    const h = createHarness({ persistence });
    const session = createWatchableSession(
        h.depositSessionCoordinator,
        h.depositPersistence
    );

    h.monitor.startWatching(session);

    fundSeat(h, session, { wallet: "EQ_wallet_2", tx: "tx-lena" });
    fundSeat(h, session, { wallet: "EQ_wallet_3", tx: "tx-bob" });

    const two = h.depositSessionCoordinator.getSession(session.depositId);

    assert.equal(two.state, DEPOSIT_SESSION_STATUS.PARTIALLY_FUNDED);
    assert.equal(two.bindings[0].funded, false);
    assert.equal(two.bindings[1].funded, true);
    assert.equal(two.bindings[2].funded, true);
    assert.equal(paidMask(two), 0b110);
    assert.equal(totalCredited(two), 22000000);

    fundSeat(h, session, { wallet: "EQ_wallet_1", tx: "tx-olga" });

    const full = h.depositSessionCoordinator.getSession(session.depositId);

    assert.equal(full.state, DEPOSIT_SESSION_STATUS.DEPOSIT_FULL);
    assert.equal(full.bindings.every((binding) => binding.funded === true), true);
    assert.equal(paidMask(full), 0b111);
    assert.equal(totalCredited(full), 33000000);

    const persistence2 = reopenPersistence(dataDir);
    const coordinator2 = new DepositSessionCoordinator({
        eventBus: createEventBus(createLogger()),
        persistence: new TonFinancialDepositPersistence(persistence2)
    });

    const restored = coordinator2.restoreFromPersistence(session.depositId);

    assert.equal(restored.state, DEPOSIT_SESSION_STATUS.DEPOSIT_FULL);
    assert.equal(paidMask(restored), 0b111);
    assert.equal(totalCredited(restored), 33000000);
    assert.equal(restored.bindings[0].receivedAmount, 11000000);
    assert.equal(restored.bindings[1].receivedAmount, 11000000);
    assert.equal(restored.bindings[2].receivedAmount, 11000000);

});

test("R18-S16: duplicate FundSeat observation is idempotent", () => {

    const { persistence } = createDiskPersistence();
    const h = createHarness({ persistence });
    const session = createWatchableSession(
        h.depositSessionCoordinator,
        h.depositPersistence
    );

    h.monitor.startWatching(session);

    const first = fundSeat(h, session, { wallet: "EQ_wallet_2", tx: "tx-lena" });

    assert.equal(first.observationStatus, DEPOSIT_OBSERVATION_STATUS.VALIDATED);

    let duplicateThrew = false;

    try {

        fundSeat(h, session, { wallet: "EQ_wallet_2", tx: "tx-lena" });

    } catch {

        duplicateThrew = true;

    }

    assert.equal(duplicateThrew, true);

    const alreadyFundedRetry = fundSeat(h, session, {
        wallet: "EQ_wallet_2",
        tx: "tx-lena-retry"
    });

    assert.equal(
        alreadyFundedRetry.observationStatus,
        DEPOSIT_OBSERVATION_STATUS.REJECTED
    );

    h.eventBus.emit({
        source: EVENT_SOURCES.DEPOSIT_MONITOR,
        type: EVENT_TYPES.DEPOSIT_SEAT_FUNDED,
        payload: {
            observationId: first.observationId,
            depositId: session.depositId,
            depositAddress: DEPOSIT_ADDRESS,
            transactionHash: "tx-lena",
            senderWallet: "EQ_wallet_2",
            amount: 11000000,
            observationStatus: DEPOSIT_OBSERVATION_STATUS.VALIDATED,
            status: DEPOSIT_OBSERVATION_STATUS.VALIDATED
        }
    });

    const live = h.depositSessionCoordinator.getSession(session.depositId);

    assert.equal(live.bindings[1].funded, true);
    assert.equal(live.bindings[1].receivedAmount, 11000000);
    assert.equal(live.bindings.filter((binding) => binding.funded === true).length, 1);
    assert.equal(totalCredited(live), 11000000);
    assert.equal(live.state, DEPOSIT_SESSION_STATUS.PARTIALLY_FUNDED);

});

test("R18-S16: untrusted DEPOSIT_SEAT_FUNDED does not mutate DepositSession", () => {

    const { persistence } = createDiskPersistence();
    const h = createHarness({ persistence });
    const session = createWatchableSession(
        h.depositSessionCoordinator,
        h.depositPersistence
    );

    h.eventBus.emit({
        source: EVENT_SOURCES.SOCKET_GATEWAY,
        type: EVENT_TYPES.DEPOSIT_SEAT_FUNDED,
        payload: {
            observationId: "obs-fake",
            depositId: session.depositId,
            depositAddress: DEPOSIT_ADDRESS,
            transactionHash: "tx-fake",
            senderWallet: "EQ_wallet_1",
            amount: 11000000,
            observationStatus: DEPOSIT_OBSERVATION_STATUS.VALIDATED,
            status: DEPOSIT_OBSERVATION_STATUS.VALIDATED
        }
    });

    const live = h.depositSessionCoordinator.getSession(session.depositId);

    assert.equal(live.state, DEPOSIT_SESSION_STATUS.AWAITING_FUNDS);
    assert.equal(live.bindings.every((binding) => binding.funded === false), true);
    assert.equal(totalCredited(live), 0);

});

test("R18-S16: setup timeout default is 8 minutes; unrelated timers stay 5 minutes", () => {

    const config = loadRoomConfig({ ROOM_MAX_PLAYERS: "3" });

    assert.equal(config.setupDurationMs, EIGHT_MIN_MS);
    assert.equal(config.paymentSessionDurationMs, FIVE_MIN_MS);
    assert.equal(config.walletConnectionDurationMs, FIVE_MIN_MS);
    assert.equal(config.resultSessionDurationMs, FIVE_MIN_MS);
    assert.equal(config.gameContractDeployTimeoutMs, 2 * 60 * 1000);
    assert.equal(config.gameStartAuthorizationDurationMs, 60 * 1000);

});

test("R18-S16: established financial constants remain unchanged", () => {

    const orchestrator = readFileSync(
        join(SERVER_ROOT, "..", "deposit", "DepositOrchestrator.js"),
        "utf8"
    );
    const rooms = readFileSync(
        join(SERVER_ROOT, "..", "config", "rooms.js"),
        "utf8"
    );

    assert.match(
        orchestrator,
        /const DEPOSIT_CONTRACT_DEPLOY_VALUE_NANOTONS = "10000000"/
    );
    assert.match(
        rooms,
        /const DEFAULT_SETUP_DURATION_MS = 8 \* 60 \* 1000/
    );
    assert.match(
        rooms,
        /const DEFAULT_PAYMENT_SESSION_DURATION_MS = 5 \* 60 \* 1000/
    );
    assert.doesNotMatch(
        orchestrator,
        /TON_DEPOSIT_CREATION_FEE_PER_SEAT_NANO/
    );

    const financials = readFileSync(
        join(SERVER_ROOT, "..", "deposit", "resolveDepositOrchestrationFinancials.js"),
        "utf8"
    );

    assert.match(financials, /TON_DEPOSIT_CREATION_FEE_PER_SEAT_NANO/);
    assert.match(financials, /TON_DEPOSIT_STAKE_NANOTON_BY_PROFILE/);

});
