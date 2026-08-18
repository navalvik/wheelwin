/**
 * R17.9L.6 — DepositFull → DeploymentAuthorization VALID automation tests.
 * NO TON deposit contracts, NO DepositMonitor, NO GameContractManager integration.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DepositSessionCoordinator } from "../deposit/DepositSessionCoordinator.js";
import { DeploymentAuthorizationCoordinator } from "../deposit/DeploymentAuthorizationCoordinator.js";
import { DepositFullAuthorizationAutomation } from "../deposit/DepositFullAuthorizationAutomation.js";

import { DEPOSIT_SESSION_STATUS } from "../deposit/DepositSessionStates.js";
import { TonFinancialDepositPersistence } from "../deposit/DepositPersistencePort.js";
import { TonFinancialDeploymentAuthorizationPersistence } from "../deposit/DeploymentAuthorizationPersistencePort.js";

import { DEPLOYMENT_AUTHORIZATION_STATUS } from "../deposit/DeploymentAuthorizationStates.js";
import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
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
    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-dauth-l6-"));
    const persistence = new TonFinancialPersistence({
        dataDir,
        autoCheckpoint: false
    });
    persistence.initialize();
    return { dataDir, persistence };
}

function tick() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

async function createFullDepositAndAwait({
    depositSessionCoordinator,
    roomId = "room-a",
    gameId = "game-a"
} = {}) {
    const session = depositSessionCoordinator.createSession({ roomId, gameId });
    depositSessionCoordinator.bindPlayers(session.depositId, threePlayers());
    depositSessionCoordinator.markAwaitingFunds(session.depositId);

    depositSessionCoordinator.applyFunding(session.depositId, {
        wallet: "EQ_wallet_1",
        amount: 10,
        fundingEventId: "tx-1"
    });
    depositSessionCoordinator.applyFunding(session.depositId, {
        wallet: "EQ_wallet_2",
        amount: 10,
        fundingEventId: "tx-2"
    });
    depositSessionCoordinator.applyFunding(session.depositId, {
        wallet: "EQ_wallet_3",
        amount: 10,
        fundingEventId: "tx-3"
    });

    await tick();
    assert.equal(session.state, DEPOSIT_SESSION_STATUS.DEPOSIT_FULL);

    return session;
}

test("R17.9L.6 Test1: DEPOSIT_FULL creates VALID authorization", async () => {
    const logger = createLogger();
    const eventBus = createEventBus(logger);
    const { dataDir, persistence } = createDiskPersistence();

    try {
        const depositSessionCoordinator = new DepositSessionCoordinator({
            eventBus,
            persistence: new TonFinancialDepositPersistence(persistence)
        });

        const deploymentAuthorizationCoordinator = new DeploymentAuthorizationCoordinator({
            eventBus,
            persistence: new TonFinancialDeploymentAuthorizationPersistence(persistence)
        });

        const automation = new DepositFullAuthorizationAutomation({
            logger,
            eventBus,
            depositSessionCoordinator,
            deploymentAuthorizationCoordinator
        });
        automation.initialize();

        const { roomId, gameId } = { roomId: "room-x", gameId: "game-x" };

        await createFullDepositAndAwait({ depositSessionCoordinator, roomId, gameId });

        const auth = deploymentAuthorizationCoordinator.getByRoomAndGame(roomId, gameId);
        assert.ok(auth);
        assert.equal(auth.status, DEPLOYMENT_AUTHORIZATION_STATUS.VALID);
    } finally {
        persistence.shutdown({ checkpoint: false });
        TonFinancialPersistence.destroyStorage(dataDir);
    }
});

test("R17.9L.6 Test2: PARTIALLY_FUNDED does not create authorization", async () => {
    const logger = createLogger();
    const eventBus = createEventBus(logger);
    const { dataDir, persistence } = createDiskPersistence();

    try {
        const depositSessionCoordinator = new DepositSessionCoordinator({
            eventBus,
            persistence: new TonFinancialDepositPersistence(persistence)
        });

        const deploymentAuthorizationCoordinator = new DeploymentAuthorizationCoordinator({
            eventBus,
            persistence: new TonFinancialDeploymentAuthorizationPersistence(persistence)
        });

        const automation = new DepositFullAuthorizationAutomation({
            logger,
            eventBus,
            depositSessionCoordinator,
            deploymentAuthorizationCoordinator
        });
        automation.initialize();

        const session = depositSessionCoordinator.createSession({
            roomId: "room-partial",
            gameId: "game-partial"
        });
        depositSessionCoordinator.bindPlayers(session.depositId, threePlayers());
        depositSessionCoordinator.markAwaitingFunds(session.depositId);

        depositSessionCoordinator.applyFunding(session.depositId, {
            wallet: "EQ_wallet_1",
            amount: 10,
            fundingEventId: "tx-1"
        });

        await tick();
        assert.equal(session.state, DEPOSIT_SESSION_STATUS.PARTIALLY_FUNDED);

        assert.equal(
            deploymentAuthorizationCoordinator.getByRoomAndGame("room-partial", "game-partial"),
            null
        );
        assert.equal(persistence.listActiveDeploymentAuthorizations().length, 0);
    } finally {
        persistence.shutdown({ checkpoint: false });
        TonFinancialPersistence.destroyStorage(dataDir);
    }
});

test("R17.9L.6 Test3: Duplicate DEPOSIT_FULL event creates one authorization only", async () => {
    const logger = createLogger();
    const eventBus = createEventBus(logger);
    const { dataDir, persistence } = createDiskPersistence();

    try {
        const depositSessionCoordinator = new DepositSessionCoordinator({
            eventBus,
            persistence: new TonFinancialDepositPersistence(persistence)
        });

        const deploymentAuthorizationCoordinator = new DeploymentAuthorizationCoordinator({
            eventBus,
            persistence: new TonFinancialDeploymentAuthorizationPersistence(persistence)
        });

        const automation = new DepositFullAuthorizationAutomation({
            logger,
            eventBus,
            depositSessionCoordinator,
            deploymentAuthorizationCoordinator
        });
        automation.initialize();

        const roomId = "room-dup";
        const gameId = "game-dup";

        const session = await createFullDepositAndAwait({ depositSessionCoordinator, roomId, gameId });

        const auth1 = deploymentAuthorizationCoordinator.getByRoomAndGame(roomId, gameId);
        assert.ok(auth1);
        assert.equal(auth1.status, DEPLOYMENT_AUTHORIZATION_STATUS.VALID);

        // Simulate the server receiving the same DEPOSIT_FULL envelope twice.
        eventBus.emit({
            source: "test",
            type: EVENT_TYPES.DEPOSIT_FULL,
            payload: session
        });

        await tick();

        const auth2 = deploymentAuthorizationCoordinator.getByRoomAndGame(roomId, gameId);
        assert.ok(auth2);
        assert.equal(auth2.status, DEPLOYMENT_AUTHORIZATION_STATUS.VALID);
        assert.equal(auth2.authorizationId, auth1.authorizationId);

        assert.equal(persistence.listActiveDeploymentAuthorizations().length, 1);
    } finally {
        persistence.shutdown({ checkpoint: false });
        TonFinancialPersistence.destroyStorage(dataDir);
    }
});

test("R17.9L.6 Test4: Wrong deposit state rejects authorization creation", async () => {
    const logger = createLogger();
    const eventBus = createEventBus(logger);
    const { dataDir, persistence } = createDiskPersistence();

    try {
        const depositSessionCoordinator = new DepositSessionCoordinator({
            eventBus,
            persistence: new TonFinancialDepositPersistence(persistence)
        });

        const deploymentAuthorizationCoordinator = new DeploymentAuthorizationCoordinator({
            eventBus,
            persistence: new TonFinancialDeploymentAuthorizationPersistence(persistence)
        });

        const automation = new DepositFullAuthorizationAutomation({
            logger,
            eventBus,
            depositSessionCoordinator,
            deploymentAuthorizationCoordinator
        });
        automation.initialize();

        const roomId = "room-wrong-state";
        const gameId = "game-wrong-state";

        const session = depositSessionCoordinator.createSession({ roomId, gameId });
        depositSessionCoordinator.bindPlayers(session.depositId, threePlayers());
        depositSessionCoordinator.markAwaitingFunds(session.depositId);
        depositSessionCoordinator.applyFunding(session.depositId, {
            wallet: "EQ_wallet_1",
            amount: 10,
            fundingEventId: "tx-1"
        });

        await tick();
        assert.equal(session.state, DEPOSIT_SESSION_STATUS.PARTIALLY_FUNDED);

        // Manually emit a forged DEPOSIT_FULL envelope.
        eventBus.emit({
            source: "test",
            type: EVENT_TYPES.DEPOSIT_FULL,
            payload: session
        });

        await tick();

        assert.equal(
            deploymentAuthorizationCoordinator.getByRoomAndGame(roomId, gameId),
            null
        );
        assert.equal(persistence.listActiveDeploymentAuthorizations().length, 0);
    } finally {
        persistence.shutdown({ checkpoint: false });
        TonFinancialPersistence.destroyStorage(dataDir);
    }
});

test("R17.9L.6 Test5: Restart recovery restores VALID authorization from DEPOSIT_FULL", async () => {
    const logger = createLogger();

    const { dataDir, persistence } = createDiskPersistence();
    const depositEventBus = createEventBus(logger);

    try {
        const depositSessionCoordinator1 = new DepositSessionCoordinator({
            eventBus: depositEventBus,
            persistence: new TonFinancialDepositPersistence(persistence)
        });

        // No automation in the first run, so no authorization will be created.
        await createFullDepositAndAwait({
            depositSessionCoordinator: depositSessionCoordinator1,
            roomId: "room-restart",
            gameId: "game-restart"
        });
    } finally {
        persistence.shutdown({ checkpoint: false });
    }

    const persistence2 = new TonFinancialPersistence({
        dataDir,
        autoCheckpoint: false
    });
    persistence2.initialize();

    try {
        const eventBus2 = createEventBus(logger);
        const depositSessionCoordinator2 = new DepositSessionCoordinator({
            eventBus: eventBus2,
            persistence: new TonFinancialDepositPersistence(persistence2)
        });

        const deploymentAuthorizationCoordinator2 = new DeploymentAuthorizationCoordinator({
            eventBus: eventBus2,
            persistence: new TonFinancialDeploymentAuthorizationPersistence(persistence2)
        });

        // Simulate TonFinancialRecovery restoring sessions/authorizations.
        depositSessionCoordinator2.restoreActiveSessions();
        deploymentAuthorizationCoordinator2.restoreActiveAuthorizations();

        const automation2 = new DepositFullAuthorizationAutomation({
            logger,
            eventBus: eventBus2,
            depositSessionCoordinator: depositSessionCoordinator2,
            deploymentAuthorizationCoordinator: deploymentAuthorizationCoordinator2
        });
        automation2.initialize();
        automation2.syncFromActiveDepositSessions();

        const auth = deploymentAuthorizationCoordinator2.getByRoomAndGame("room-restart", "game-restart");
        assert.ok(auth);
        assert.equal(auth.status, DEPLOYMENT_AUTHORIZATION_STATUS.VALID);
        assert.equal(persistence2.listActiveDeploymentAuthorizations().length, 1);
    } finally {
        persistence2.shutdown({ checkpoint: false });
        TonFinancialPersistence.destroyStorage(dataDir);
    }
});

test("R17.9L.6 Test6: Security isolation — automation does not deploy or spend TON", async () => {
    const logger = createLogger();
    const eventBus = createEventBus(logger);
    const { dataDir, persistence } = createDiskPersistence();

    try {
        let deployAttemptCount = 0;

        eventBus.subscribe(EVENT_TYPES.GAME_CONTRACT_DEPLOYED, () => {
            deployAttemptCount += 1;
        });
        eventBus.subscribe(EVENT_TYPES.GAME_CONTRACT_DEPLOY_FAILED, () => {
            deployAttemptCount += 1;
        });

        const depositSessionCoordinator = new DepositSessionCoordinator({
            eventBus,
            persistence: new TonFinancialDepositPersistence(persistence)
        });

        const deploymentAuthorizationCoordinator = new DeploymentAuthorizationCoordinator({
            eventBus,
            persistence: new TonFinancialDeploymentAuthorizationPersistence(persistence)
        });

        const automation = new DepositFullAuthorizationAutomation({
            logger,
            eventBus,
            depositSessionCoordinator,
            deploymentAuthorizationCoordinator
        });
        automation.initialize();

        await createFullDepositAndAwait({
            depositSessionCoordinator,
            roomId: "room-isolation",
            gameId: "game-isolation"
        });

        assert.equal(deployAttemptCount, 0);

        // Only deployment authorization records should exist (no blockchain/deploy artifacts).
        assert.equal(persistence.listActiveDeploymentAuthorizations().length, 1);
    } finally {
        persistence.shutdown({ checkpoint: false });
        TonFinancialPersistence.destroyStorage(dataDir);
    }
});

