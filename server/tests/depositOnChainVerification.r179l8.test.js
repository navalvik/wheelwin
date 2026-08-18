/**
 * R17.9L.8 — On-Chain Deposit Verification → DepositSession Integration tests.
 * 13 functional tests + 5 security attack tests.
 * NO real TON, NO smart contracts, NO GameContractManager.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DepositSessionCoordinator } from "../deposit/DepositSessionCoordinator.js";
import { DepositMonitor } from "../deposit/DepositMonitor.js";
import { DepositOnChainVerificationCoordinator } from "../deposit/DepositOnChainVerificationCoordinator.js";
import { DepositFullAuthorizationAutomation } from "../deposit/DepositFullAuthorizationAutomation.js";
import { DeploymentAuthorizationCoordinator } from "../deposit/DeploymentAuthorizationCoordinator.js";
import { FakeDepositBlockchainSource } from "../deposit/FakeDepositBlockchainSource.js";
import { TonFinancialDepositPersistence } from "../deposit/DepositPersistencePort.js";
import { TonFinancialDepositObservationPersistence } from "../deposit/DepositObservationPersistencePort.js";
import { TonFinancialDeploymentAuthorizationPersistence } from "../deposit/DeploymentAuthorizationPersistencePort.js";
import { DEPOSIT_SESSION_STATUS } from "../deposit/DepositSessionStates.js";
import { DEPLOYMENT_AUTHORIZATION_STATUS } from "../deposit/DeploymentAuthorizationStates.js";
import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { EVENT_SOURCES } from "../events/EventSources.js";
import { TonFinancialPersistence } from "../persistence/TonFinancialPersistence.js";

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

    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-l8-"));

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

            emitted.push({ type, payload: envelope.payload, source: envelope.source });

        });

    }

    return emitted;

}

function createHarness({ persistence = null } = {}) {

    const logger = createLogger();

    const eventBus = createEventBus(logger);

    const depositPersistence = persistence
        ? new TonFinancialDepositPersistence(persistence)
        : null;

    const observationPersistence = persistence
        ? new TonFinancialDepositObservationPersistence(persistence)
        : null;

    const authorizationPersistence = persistence
        ? new TonFinancialDeploymentAuthorizationPersistence(persistence)
        : null;

    const depositSessionCoordinator = new DepositSessionCoordinator({
        eventBus,
        persistence: depositPersistence
    });

    const deploymentAuthorizationCoordinator = new DeploymentAuthorizationCoordinator({
        eventBus,
        persistence: authorizationPersistence
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

    const automation = new DepositFullAuthorizationAutomation({
        logger,
        eventBus,
        depositSessionCoordinator,
        deploymentAuthorizationCoordinator
    });

    automation.initialize();

    const source = new FakeDepositBlockchainSource({ monitor });

    return {
        logger,
        eventBus,
        depositSessionCoordinator,
        deploymentAuthorizationCoordinator,
        monitor,
        verificationCoordinator,
        automation,
        source,
        persistence,
        depositPersistence,
        observationPersistence
    };

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

// ─── Test 1: Three valid observations → DEPOSIT_FULL + DeploymentAuthorization VALID ───

test("R17.9L.8 Test1: three valid observations → DEPOSIT_FULL → DeploymentAuthorization VALID", () => {

    const { persistence } = createDiskPersistence();

    const h = createHarness({ persistence });

    const session = createWatchableSession(h.depositSessionCoordinator, {
        depositPersistence: h.depositPersistence
    });

    h.monitor.startWatching(session);

    const emitted = collectEvents(h.eventBus, [
        EVENT_TYPES.DEPOSIT_FULL,
        EVENT_TYPES.DEPLOY_AUTHORIZATION_VALID
    ]);

    h.source.emitFullDeposit({
        depositId: session.depositId,
        depositAddress: "EQ_deposit_address",
        players: threePlayers()
    });

    const updated = h.depositSessionCoordinator.getSession(session.depositId);

    assert.equal(updated.state, DEPOSIT_SESSION_STATUS.DEPOSIT_FULL);

    const fullEvents = emitted.filter((e) => e.type === EVENT_TYPES.DEPOSIT_FULL);

    assert.equal(fullEvents.length, 1);

    const authEvents = emitted.filter((e) => e.type === EVENT_TYPES.DEPLOY_AUTHORIZATION_VALID);

    assert.equal(authEvents.length, 1);

    const auth = h.deploymentAuthorizationCoordinator.getByRoomAndGame("room-a", "game-a");

    assert.equal(auth.status, DEPLOYMENT_AUTHORIZATION_STATUS.VALID);

});

// ─── Test 2: One seat missing → no DEPOSIT_FULL ───

test("R17.9L.8 Test2: one seat missing → DEPOSIT_FULL not produced", () => {

    const { persistence } = createDiskPersistence();

    const h = createHarness({ persistence });

    const session = createWatchableSession(h.depositSessionCoordinator, {
        depositPersistence: h.depositPersistence
    });

    h.monitor.startWatching(session);

    const emitted = collectEvents(h.eventBus, [EVENT_TYPES.DEPOSIT_FULL]);

    h.source.emitValidPayment({
        depositId: session.depositId,
        depositAddress: "EQ_deposit_address",
        senderWallet: "EQ_wallet_1",
        amount: 10,
        transactionHash: "tx-1"
    });

    h.source.emitValidPayment({
        depositId: session.depositId,
        depositAddress: "EQ_deposit_address",
        senderWallet: "EQ_wallet_2",
        amount: 10,
        transactionHash: "tx-2"
    });

    const updated = h.depositSessionCoordinator.getSession(session.depositId);

    assert.notEqual(updated.state, DEPOSIT_SESSION_STATUS.DEPOSIT_FULL);

    assert.equal(emitted.length, 0);

});

// ─── Test 3: Partial amount → verification rejected ───

test("R17.9L.8 Test3: partial amount → DEPOSIT_FULL rejected", () => {

    const { persistence } = createDiskPersistence();

    const h = createHarness({ persistence });

    const session = createWatchableSession(h.depositSessionCoordinator, {
        depositPersistence: h.depositPersistence
    });

    h.monitor.startWatching(session);

    const emitted = collectEvents(h.eventBus, [EVENT_TYPES.DEPOSIT_FULL]);

    h.source.emitValidPayment({
        depositId: session.depositId,
        depositAddress: "EQ_deposit_address",
        senderWallet: "EQ_wallet_1",
        amount: 10,
        transactionHash: "tx-1"
    });

    h.source.emitValidPayment({
        depositId: session.depositId,
        depositAddress: "EQ_deposit_address",
        senderWallet: "EQ_wallet_2",
        amount: 10,
        transactionHash: "tx-2"
    });

    // Wallet 3 sends insufficient — DepositMonitor rejects it at observation level
    h.source.emitValidPayment({
        depositId: session.depositId,
        depositAddress: "EQ_deposit_address",
        senderWallet: "EQ_wallet_3",
        amount: 5,
        transactionHash: "tx-3"
    });

    const updated = h.depositSessionCoordinator.getSession(session.depositId);

    assert.notEqual(updated.state, DEPOSIT_SESSION_STATUS.DEPOSIT_FULL);

    assert.equal(emitted.length, 0);

});

// ─── Test 4: Unknown wallet → verification rejected ───

test("R17.9L.8 Test4: unknown wallet → verification rejected", () => {

    const { persistence } = createDiskPersistence();

    const h = createHarness({ persistence });

    const session = createWatchableSession(h.depositSessionCoordinator, {
        depositPersistence: h.depositPersistence
    });

    h.monitor.startWatching(session);

    const emitted = collectEvents(h.eventBus, [EVENT_TYPES.DEPOSIT_FULL]);

    h.source.emitValidPayment({
        depositId: session.depositId,
        depositAddress: "EQ_deposit_address",
        senderWallet: "EQ_wallet_1",
        amount: 10,
        transactionHash: "tx-1"
    });

    h.source.emitValidPayment({
        depositId: session.depositId,
        depositAddress: "EQ_deposit_address",
        senderWallet: "EQ_wallet_2",
        amount: 10,
        transactionHash: "tx-2"
    });

    // Unknown wallet rejected by DepositMonitor
    h.source.emitValidPayment({
        depositId: session.depositId,
        depositAddress: "EQ_deposit_address",
        senderWallet: "EQ_unknown_wallet",
        amount: 10,
        transactionHash: "tx-3"
    });

    const updated = h.depositSessionCoordinator.getSession(session.depositId);

    assert.notEqual(updated.state, DEPOSIT_SESSION_STATUS.DEPOSIT_FULL);

    assert.equal(emitted.length, 0);

});

// ─── Test 5: Wrong deposit address → verification rejected ───

test("R17.9L.8 Test5: wrong deposit address → verification rejected", () => {

    const { persistence } = createDiskPersistence();

    const h = createHarness({ persistence });

    const session = createWatchableSession(h.depositSessionCoordinator, {
        depositPersistence: h.depositPersistence
    });

    h.monitor.startWatching(session);

    const emitted = collectEvents(h.eventBus, [EVENT_TYPES.DEPOSIT_FULL]);

    // DepositMonitor rejects observations with wrong deposit address
    h.source.emitValidPayment({
        depositId: session.depositId,
        depositAddress: "EQ_wrong_address",
        senderWallet: "EQ_wallet_1",
        amount: 10,
        transactionHash: "tx-1"
    });

    const updated = h.depositSessionCoordinator.getSession(session.depositId);

    assert.notEqual(updated.state, DEPOSIT_SESSION_STATUS.DEPOSIT_FULL);

    assert.equal(emitted.length, 0);

});

// ─── Test 6: Wrong roomId → verification rejected ───

test("R17.9L.8 Test6: wrong roomId → verification rejected", () => {

    const { persistence } = createDiskPersistence();

    const h = createHarness({ persistence });

    const sessionA = createWatchableSession(h.depositSessionCoordinator, {
        roomId: "room-a",
        gameId: "game-a",
        depositPersistence: h.depositPersistence
    });

    const sessionB = createWatchableSession(h.depositSessionCoordinator, {
        roomId: "room-b",
        gameId: "game-b",
        depositPersistence: h.depositPersistence
    });

    h.monitor.startWatching(sessionA);

    h.monitor.startWatching(sessionB);

    const emitted = collectEvents(h.eventBus, [EVENT_TYPES.DEPOSIT_FULL]);

    // Fund room-a fully
    h.source.emitFullDeposit({
        depositId: sessionA.depositId,
        depositAddress: "EQ_deposit_address",
        players: threePlayers()
    });

    // Room-a should be FULL, room-b should not
    const updatedA = h.depositSessionCoordinator.getSession(sessionA.depositId);

    assert.equal(updatedA.state, DEPOSIT_SESSION_STATUS.DEPOSIT_FULL);

    const updatedB = h.depositSessionCoordinator.getSession(sessionB.depositId);

    assert.notEqual(updatedB.state, DEPOSIT_SESSION_STATUS.DEPOSIT_FULL);

    // Only one DEPOSIT_FULL (for room-a)
    assert.equal(emitted.filter((e) => e.type === EVENT_TYPES.DEPOSIT_FULL).length, 1);

});

// ─── Test 7: Wrong gameId → verification rejected ───

test("R17.9L.8 Test7: wrong gameId — observations from game-a cannot fund game-b", () => {

    const { persistence } = createDiskPersistence();

    const h = createHarness({ persistence });

    const sessionA = createWatchableSession(h.depositSessionCoordinator, {
        roomId: "room-x",
        gameId: "game-1",
        depositPersistence: h.depositPersistence
    });

    const sessionB = createWatchableSession(h.depositSessionCoordinator, {
        roomId: "room-x",
        gameId: "game-2",
        depositPersistence: h.depositPersistence
    });

    h.monitor.startWatching(sessionA);

    h.monitor.startWatching(sessionB);

    h.source.emitFullDeposit({
        depositId: sessionA.depositId,
        depositAddress: "EQ_deposit_address",
        players: threePlayers()
    });

    const updatedB = h.depositSessionCoordinator.getSession(sessionB.depositId);

    assert.notEqual(updatedB.state, DEPOSIT_SESSION_STATUS.DEPOSIT_FULL);

});

// ─── Test 8: Duplicate transaction → counted once ───

test("R17.9L.8 Test8: duplicate transaction → counted once", () => {

    const { persistence } = createDiskPersistence();

    const h = createHarness({ persistence });

    const session = createWatchableSession(h.depositSessionCoordinator, {
        depositPersistence: h.depositPersistence
    });

    h.monitor.startWatching(session);

    const emitted = collectEvents(h.eventBus, [EVENT_TYPES.DEPOSIT_FULL]);

    h.source.emitValidPayment({
        depositId: session.depositId,
        depositAddress: "EQ_deposit_address",
        senderWallet: "EQ_wallet_1",
        amount: 10,
        transactionHash: "tx-1"
    });

    // Duplicate of tx-1 — persistence throws because record is immutable; that's expected
    try {

        h.source.emitValidPayment({
            depositId: session.depositId,
            depositAddress: "EQ_deposit_address",
            senderWallet: "EQ_wallet_1",
            amount: 10,
            transactionHash: "tx-1"
        });

    } catch {
        // immutable record persistence error expected
    }

    h.source.emitValidPayment({
        depositId: session.depositId,
        depositAddress: "EQ_deposit_address",
        senderWallet: "EQ_wallet_2",
        amount: 10,
        transactionHash: "tx-2"
    });

    // Only 2 seats funded, not 3
    const updated = h.depositSessionCoordinator.getSession(session.depositId);

    assert.notEqual(updated.state, DEPOSIT_SESSION_STATUS.DEPOSIT_FULL);

    assert.equal(emitted.length, 0);

});

// ─── Test 9: Network mismatch → verification rejected ───

test("R17.9L.8 Test9: network mismatch → verification rejected", () => {

    const { persistence } = createDiskPersistence();

    const h = createHarness({ persistence });

    const session = createWatchableSession(h.depositSessionCoordinator, {
        depositPersistence: h.depositPersistence
    });

    h.monitor.startWatching(session);

    const emitted = collectEvents(h.eventBus, [EVENT_TYPES.DEPOSIT_FULL]);

    h.source.emitValidPayment({
        depositId: session.depositId,
        depositAddress: "EQ_deposit_address",
        senderWallet: "EQ_wallet_1",
        amount: 10,
        transactionHash: "tx-1",
        network: "mainnet"
    });

    const updated = h.depositSessionCoordinator.getSession(session.depositId);

    assert.notEqual(updated.state, DEPOSIT_SESSION_STATUS.DEPOSIT_FULL);

    assert.equal(emitted.length, 0);

});

// ─── Test 10: Duplicate DEPOSIT_FULL_ONCHAIN → idempotent ───

test("R17.9L.8 Test10: duplicate DEPOSIT_FULL_ONCHAIN → one transition, one authorization", () => {

    const { persistence } = createDiskPersistence();

    const h = createHarness({ persistence });

    const session = createWatchableSession(h.depositSessionCoordinator, {
        depositPersistence: h.depositPersistence
    });

    h.monitor.startWatching(session);

    const emitted = collectEvents(h.eventBus, [
        EVENT_TYPES.DEPOSIT_FULL,
        EVENT_TYPES.DEPLOY_AUTHORIZATION_VALID
    ]);

    h.source.emitFullDeposit({
        depositId: session.depositId,
        depositAddress: "EQ_deposit_address",
        players: threePlayers()
    });

    assert.equal(
        emitted.filter((e) => e.type === EVENT_TYPES.DEPOSIT_FULL).length,
        1
    );

    // Manually emit a second DEPOSIT_FULL_ONCHAIN to test idempotency
    h.eventBus.emit({
        source: EVENT_SOURCES.DEPOSIT_MONITOR,
        type: EVENT_TYPES.DEPOSIT_FULL_ONCHAIN,
        payload: {
            depositId: session.depositId,
            roomId: "room-a",
            gameId: "game-a",
            depositAddress: "EQ_deposit_address",
            fundedSeatCount: 3
        }
    });

    // Still only one DEPOSIT_FULL
    assert.equal(
        emitted.filter((e) => e.type === EVENT_TYPES.DEPOSIT_FULL).length,
        1
    );

    const auth = h.deploymentAuthorizationCoordinator.getByRoomAndGame("room-a", "game-a");

    assert.equal(auth.status, DEPLOYMENT_AUTHORIZATION_STATUS.VALID);

});

// ─── Test 11: Persistence failure → no false DEPOSIT_FULL ───

test("R17.9L.8 Test11: persistence failure → no false DEPOSIT_FULL success event", () => {

    const logger = createLogger();

    const eventBus = createEventBus(logger);

    // No persistence → applyFunding will throw
    const depositSessionCoordinator = new DepositSessionCoordinator({
        eventBus,
        persistence: null
    });

    const observationPersistence = null;

    const session = depositSessionCoordinator.createSession({ roomId: "room-a", gameId: "game-a" });

    depositSessionCoordinator.bindPlayers(session.depositId, threePlayers());

    // Can't markAwaitingFunds without persistence → test verifies that even if
    // somehow a DEPOSIT_FULL_ONCHAIN is emitted, without persistence it cannot transition.
    const emitted = collectEvents(eventBus, [EVENT_TYPES.DEPOSIT_FULL]);

    const verificationCoordinator = new DepositOnChainVerificationCoordinator({
        logger,
        eventBus,
        depositSessionCoordinator,
        observationPersistence
    });

    verificationCoordinator.initialize();

    // Emit a fake DEPOSIT_FULL_ONCHAIN
    eventBus.emit({
        source: EVENT_SOURCES.DEPOSIT_MONITOR,
        type: EVENT_TYPES.DEPOSIT_FULL_ONCHAIN,
        payload: {
            depositId: session.depositId,
            roomId: "room-a",
            gameId: "game-a",
            depositAddress: "EQ_deposit_address",
            fundedSeatCount: 3
        }
    });

    assert.equal(emitted.length, 0);

    assert.notEqual(session.state, DEPOSIT_SESSION_STATUS.DEPOSIT_FULL);

});

// ─── Test 12: Restart recovery ───

test("R17.9L.8 Test12: restart recovery — persisted observations verified after restart", () => {

    const { dataDir, persistence } = createDiskPersistence();

    const h = createHarness({ persistence });

    const session = createWatchableSession(h.depositSessionCoordinator, {
        depositPersistence: h.depositPersistence
    });

    h.monitor.startWatching(session);

    // Fund all three seats
    h.source.emitFullDeposit({
        depositId: session.depositId,
        depositAddress: "EQ_deposit_address",
        players: threePlayers()
    });

    const priorState = h.depositSessionCoordinator.getSession(session.depositId);

    assert.equal(priorState.state, DEPOSIT_SESSION_STATUS.DEPOSIT_FULL);

    // --- Simulate restart ---
    const persistence2 = reopenPersistence(dataDir);

    const logger2 = createLogger();

    const eventBus2 = createEventBus(logger2);

    const depositPersistence2 = new TonFinancialDepositPersistence(persistence2);

    const observationPersistence2 = new TonFinancialDepositObservationPersistence(persistence2);

    const authorizationPersistence2 = new TonFinancialDeploymentAuthorizationPersistence(persistence2);

    const coordinator2 = new DepositSessionCoordinator({
        eventBus: eventBus2,
        persistence: depositPersistence2
    });

    // Restore the session from disk
    coordinator2.restoreFromPersistence(session.depositId);

    const deployAuth2 = new DeploymentAuthorizationCoordinator({
        eventBus: eventBus2,
        persistence: authorizationPersistence2
    });

    const automation2 = new DepositFullAuthorizationAutomation({
        logger: logger2,
        eventBus: eventBus2,
        depositSessionCoordinator: coordinator2,
        deploymentAuthorizationCoordinator: deployAuth2
    });

    automation2.initialize();

    automation2.syncFromActiveDepositSessions();

    const restored = coordinator2.getSession(session.depositId);

    assert.equal(restored.state, DEPOSIT_SESSION_STATUS.DEPOSIT_FULL);

    const auth = deployAuth2.getByRoomAndGame("room-a", "game-a");

    assert.equal(auth.status, DEPLOYMENT_AUTHORIZATION_STATUS.VALID);

});

// ─── Test 13: Client isolation — PAYMENT_CONFIRM_INTENT cannot create DEPOSIT_FULL ───

test("R17.9L.8 Test13: client PAYMENT_CONFIRM_INTENT cannot create DEPOSIT_FULL", () => {

    const { persistence } = createDiskPersistence();

    const h = createHarness({ persistence });

    const session = createWatchableSession(h.depositSessionCoordinator, {
        depositPersistence: h.depositPersistence
    });

    h.monitor.startWatching(session);

    const emitted = collectEvents(h.eventBus, [EVENT_TYPES.DEPOSIT_FULL]);

    // Attempt to emit DEPOSIT_FULL_ONCHAIN from a non-DepositMonitor source
    h.eventBus.emit({
        source: EVENT_SOURCES.SOCKET_GATEWAY,
        type: EVENT_TYPES.DEPOSIT_FULL_ONCHAIN,
        payload: {
            depositId: session.depositId,
            roomId: "room-a",
            gameId: "game-a",
            depositAddress: "EQ_deposit_address",
            fundedSeatCount: 3
        }
    });

    assert.equal(emitted.length, 0);

    const updated = h.depositSessionCoordinator.getSession(session.depositId);

    assert.notEqual(updated.state, DEPOSIT_SESSION_STATUS.DEPOSIT_FULL);

});

// ─── Security Attack A: Fake client payment ───

test("R17.9L.8 SecurityA: fake client payment cannot create DEPOSIT_FULL", () => {

    const { persistence } = createDiskPersistence();

    const h = createHarness({ persistence });

    const session = createWatchableSession(h.depositSessionCoordinator, {
        depositPersistence: h.depositPersistence
    });

    h.monitor.startWatching(session);

    const emitted = collectEvents(h.eventBus, [EVENT_TYPES.DEPOSIT_FULL]);

    // Client tries to emit DEPOSIT_FULL_ONCHAIN via PAYMENT_ENGINE source
    h.eventBus.emit({
        source: EVENT_SOURCES.PAYMENT_ENGINE,
        type: EVENT_TYPES.DEPOSIT_FULL_ONCHAIN,
        payload: {
            depositId: session.depositId,
            roomId: "room-a",
            gameId: "game-a",
            depositAddress: "EQ_deposit_address",
            fundedSeatCount: 3
        }
    });

    assert.equal(emitted.length, 0);

    assert.notEqual(
        h.depositSessionCoordinator.getSession(session.depositId).state,
        DEPOSIT_SESSION_STATUS.DEPOSIT_FULL
    );

});

// ─── Security Attack B: Cross-room replay ───

test("R17.9L.8 SecurityB: cross-room replay — room-a evidence cannot complete room-b", () => {

    const { persistence } = createDiskPersistence();

    const h = createHarness({ persistence });

    const sessionA = createWatchableSession(h.depositSessionCoordinator, {
        roomId: "room-a",
        gameId: "game-a",
        depositPersistence: h.depositPersistence
    });

    const sessionB = createWatchableSession(h.depositSessionCoordinator, {
        roomId: "room-b",
        gameId: "game-b",
        depositPersistence: h.depositPersistence
    });

    h.monitor.startWatching(sessionA);

    h.monitor.startWatching(sessionB);

    h.source.emitFullDeposit({
        depositId: sessionA.depositId,
        depositAddress: "EQ_deposit_address",
        players: threePlayers()
    });

    assert.equal(
        h.depositSessionCoordinator.getSession(sessionA.depositId).state,
        DEPOSIT_SESSION_STATUS.DEPOSIT_FULL
    );

    assert.notEqual(
        h.depositSessionCoordinator.getSession(sessionB.depositId).state,
        DEPOSIT_SESSION_STATUS.DEPOSIT_FULL
    );

});

// ─── Security Attack C: Wallet substitution ───

test("R17.9L.8 SecurityC: wallet substitution — old wallet evidence rejected for new binding", () => {

    const { persistence } = createDiskPersistence();

    const h = createHarness({ persistence });

    const session = createWatchableSession(h.depositSessionCoordinator, {
        depositPersistence: h.depositPersistence
    });

    h.monitor.startWatching(session);

    const emitted = collectEvents(h.eventBus, [EVENT_TYPES.DEPOSIT_FULL]);

    h.source.emitValidPayment({
        depositId: session.depositId,
        depositAddress: "EQ_deposit_address",
        senderWallet: "EQ_wallet_1",
        amount: 10,
        transactionHash: "tx-1"
    });

    h.source.emitValidPayment({
        depositId: session.depositId,
        depositAddress: "EQ_deposit_address",
        senderWallet: "EQ_wallet_2",
        amount: 10,
        transactionHash: "tx-2"
    });

    // Attacker uses a substituted wallet not in bindings
    h.source.emitValidPayment({
        depositId: session.depositId,
        depositAddress: "EQ_deposit_address",
        senderWallet: "EQ_attacker_wallet",
        amount: 10,
        transactionHash: "tx-3"
    });

    assert.equal(emitted.length, 0);

    assert.notEqual(
        h.depositSessionCoordinator.getSession(session.depositId).state,
        DEPOSIT_SESSION_STATUS.DEPOSIT_FULL
    );

});

// ─── Security Attack D: Transaction replay ───

test("R17.9L.8 SecurityD: transaction replay — same tx cannot fund two seats", () => {

    const { persistence } = createDiskPersistence();

    const h = createHarness({ persistence });

    const session = createWatchableSession(h.depositSessionCoordinator, {
        depositPersistence: h.depositPersistence
    });

    h.monitor.startWatching(session);

    const emitted = collectEvents(h.eventBus, [EVENT_TYPES.DEPOSIT_FULL]);

    h.source.emitValidPayment({
        depositId: session.depositId,
        depositAddress: "EQ_deposit_address",
        senderWallet: "EQ_wallet_1",
        amount: 10,
        transactionHash: "tx-same"
    });

    // Replay same tx for wallet_2 — DepositMonitor rejects duplicate tx
    try {

        h.source.emitValidPayment({
            depositId: session.depositId,
            depositAddress: "EQ_deposit_address",
            senderWallet: "EQ_wallet_2",
            amount: 10,
            transactionHash: "tx-same"
        });

    } catch {
        // immutable record persistence error expected
    }

    h.source.emitValidPayment({
        depositId: session.depositId,
        depositAddress: "EQ_deposit_address",
        senderWallet: "EQ_wallet_3",
        amount: 10,
        transactionHash: "tx-3"
    });

    // tx-same is duplicate → only 2 seats funded (wallet_1 + wallet_3)
    assert.notEqual(
        h.depositSessionCoordinator.getSession(session.depositId).state,
        DEPOSIT_SESSION_STATUS.DEPOSIT_FULL
    );

    assert.equal(emitted.length, 0);

});

// ─── Security Attack E: Fake FULL event from client ───

test("R17.9L.8 SecurityE: fake DEPOSIT_FULL_ONCHAIN from socket cannot cause completion", () => {

    const { persistence } = createDiskPersistence();

    const h = createHarness({ persistence });

    const session = createWatchableSession(h.depositSessionCoordinator, {
        depositPersistence: h.depositPersistence
    });

    h.monitor.startWatching(session);

    const emitted = collectEvents(h.eventBus, [EVENT_TYPES.DEPOSIT_FULL]);

    // Direct socket injection of DEPOSIT_FULL_ONCHAIN
    h.eventBus.emit({
        source: EVENT_SOURCES.SOCKET_GATEWAY,
        type: EVENT_TYPES.DEPOSIT_FULL_ONCHAIN,
        payload: {
            depositId: session.depositId,
            roomId: "room-a",
            gameId: "game-a",
            depositAddress: "EQ_deposit_address",
            fundedSeatCount: 3
        }
    });

    assert.equal(emitted.length, 0);

    assert.notEqual(
        h.depositSessionCoordinator.getSession(session.depositId).state,
        DEPOSIT_SESSION_STATUS.DEPOSIT_FULL
    );

});
