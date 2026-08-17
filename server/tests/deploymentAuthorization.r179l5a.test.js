/**
 * R17.9L.5A — DeploymentAuthorization domain, hash, persistence, and recovery tests.
 * No TON, no GCM gate, no DepositMonitor, no Page4.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DepositSession } from "../deposit/DepositSession.js";
import { DEPOSIT_SESSION_STATUS } from "../deposit/DepositSessionStates.js";
import { DeploymentAuthorization } from "../deposit/DeploymentAuthorization.js";
import { DeploymentAuthorizationCoordinator } from "../deposit/DeploymentAuthorizationCoordinator.js";
import { InvalidDeploymentAuthorizationError, InvalidDeploymentAuthorizationTransitionError } from "../deposit/DeploymentAuthorizationErrors.js";
import { TonFinancialDeploymentAuthorizationPersistence } from "../deposit/DeploymentAuthorizationPersistencePort.js";
import { DEPLOYMENT_AUTHORIZATION_STATUS } from "../deposit/DeploymentAuthorizationStates.js";
import {
    computeDepositBindingHash,
    computeDeploymentAuthorizationHash
} from "../deposit/deploymentAuthorizationHash.js";
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

function fundAll(session) {

    session.applyFunding({ wallet: "EQ_wallet_1", amount: 10, fundingEventId: "tx-1" });
    session.applyFunding({ wallet: "EQ_wallet_2", amount: 10, fundingEventId: "tx-2" });
    session.applyFunding({ wallet: "EQ_wallet_3", amount: 10, fundingEventId: "tx-3" });

}

function fullDepositSession({ roomId = "room-a", gameId = "game-a", metadata = null } = {}) {

    const session = new DepositSession({ roomId, gameId, metadata });

    session.bindPlayers(threePlayers());
    session.markAwaitingFunds();
    fundAll(session);

    return session;

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

    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-dauth-l5a-"));

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

test("R17.9L.5A creates authorization from DEPOSIT_FULL", () => {

    const session = fullDepositSession();
    const authorization = DeploymentAuthorization.fromDepositSession(session);

    assert.equal(authorization.status, DEPLOYMENT_AUTHORIZATION_STATUS.CREATED);
    assert.equal(authorization.roomId, session.roomId);
    assert.equal(authorization.gameId, session.gameId);
    assert.equal(authorization.depositId, session.depositId);
    assert.ok(authorization.bindingHash);
    assert.equal(authorization.bindingHash, session.bindingHash);
    assert.ok(authorization.authorizationHash);
    assert.ok(authorization.depositStateSnapshot);
    assert.equal(authorization.depositStateSnapshot.state, DEPOSIT_SESSION_STATUS.DEPOSIT_FULL);
    assert.equal(authorization.toRecord().recordType, TON_FINANCIAL_RECORD_TYPES.DEPLOYMENT_AUTHORIZATION);

});

test("R17.9L.5A rejects authorization from AWAITING_FUNDS", () => {

    const session = new DepositSession({ roomId: "room-b", gameId: "game-b" });

    session.bindPlayers(threePlayers());
    session.markAwaitingFunds();

    assert.throws(
        () => DeploymentAuthorization.fromDepositSession(session),
        (error) => error instanceof InvalidDeploymentAuthorizationError
    );

});

test("R17.9L.5A rejects authorization without depositId", () => {

    assert.throws(
        () => DeploymentAuthorization.fromDepositSession({
            roomId: "room-c",
            gameId: "game-c",
            state: DEPOSIT_SESSION_STATUS.DEPOSIT_FULL,
            bindingHash: "abc",
            bindings: threePlayers()
        }),
        (error) => error instanceof InvalidDeploymentAuthorizationError
            && /depositId is required/.test(error.message)
    );

});

test("R17.9L.5A allows CREATED to VALID to CONSUMED", () => {

    const authorization = DeploymentAuthorization.fromDepositSession(fullDepositSession());

    authorization.markValid();
    assert.equal(authorization.status, DEPLOYMENT_AUTHORIZATION_STATUS.VALID);

    authorization.consume();
    assert.equal(authorization.status, DEPLOYMENT_AUTHORIZATION_STATUS.CONSUMED);
    assert.ok(authorization.consumedAt);

});

test("R17.9L.5A rejects CREATED to CONSUMED", () => {

    const authorization = DeploymentAuthorization.fromDepositSession(fullDepositSession());

    assert.throws(
        () => authorization.consume(),
        (error) => error instanceof InvalidDeploymentAuthorizationTransitionError
    );

});

test("R17.9L.5A rejects CONSUMED to VALID", () => {

    const authorization = DeploymentAuthorization.fromDepositSession(fullDepositSession());

    authorization.markValid();
    authorization.consume();

    assert.throws(
        () => authorization.markValid(),
        (error) => error instanceof InvalidDeploymentAuthorizationTransitionError
    );

});

test("R17.9L.5A hash is deterministic and input-sensitive", () => {

    const input = {
        roomId: "room-h",
        gameId: "game-h",
        depositId: "dep-h",
        bindingHash: "bind-h",
        createdAt: 1_700_000_000_000,
        network: "testnet"
    };

    const first = computeDeploymentAuthorizationHash(input);
    const second = computeDeploymentAuthorizationHash({ ...input });

    assert.equal(first, second);

    const changedRoom = computeDeploymentAuthorizationHash({
        ...input,
        roomId: "room-other"
    });

    assert.notEqual(changedRoom, first);

    const changedBinding = computeDeploymentAuthorizationHash({
        ...input,
        bindingHash: "bind-other"
    });

    assert.notEqual(changedBinding, first);

    const bindingA = computeDepositBindingHash({
        roomId: "room-h",
        gameId: "game-h",
        depositId: "dep-h",
        bindings: threePlayers()
    });

    const bindingB = computeDepositBindingHash({
        roomId: "room-h",
        gameId: "game-h",
        depositId: "dep-h",
        bindings: threePlayers()
    });

    assert.equal(bindingA, bindingB);

});

test("R17.9L.5A persists, loads, and restores after memory loss", () => {

    const { dataDir, persistence } = createDiskPersistence();

    let authorizationId = null;
    let expectedHash = null;

    try {

        const coordinator = new DeploymentAuthorizationCoordinator({
            persistence: new TonFinancialDeploymentAuthorizationPersistence(persistence)
        });

        const session = fullDepositSession({ roomId: "room-p", gameId: "game-p" });
        const created = coordinator.createFromDepositSession(session);

        coordinator.markValid(created.authorizationId);

        authorizationId = created.authorizationId;
        expectedHash = created.authorizationHash;

        const loaded = persistence.loadDeploymentAuthorization(authorizationId);

        assert.equal(loaded.recordType, TON_FINANCIAL_RECORD_TYPES.DEPLOYMENT_AUTHORIZATION);
        assert.equal(loaded.status, DEPLOYMENT_AUTHORIZATION_STATUS.VALID);
        assert.equal(loaded.payload.depositId, session.depositId);
        assert.equal(loaded.payload.authorizationHash, expectedHash);

        const found = persistence.findDeploymentAuthorization("room-p", "game-p");

        assert.equal(found.recordId, authorizationId);

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

        const second = new DeploymentAuthorizationCoordinator({
            persistence: new TonFinancialDeploymentAuthorizationPersistence(secondPersistence)
        });

        assert.equal(second.getAuthorization(authorizationId), null);

        const summary = second.restoreActiveAuthorizations();

        assert.equal(summary.restored, 1);

        const restored = second.getAuthorization(authorizationId);

        assert.equal(restored.status, DEPLOYMENT_AUTHORIZATION_STATUS.VALID);
        assert.equal(restored.authorizationHash, expectedHash);
        assert.equal(restored.roomId, "room-p");
        assert.equal(restored.gameId, "game-p");

    } finally {

        secondPersistence.shutdown({ checkpoint: false });
        TonFinancialPersistence.destroyStorage(dataDir);

    }

});

test("R17.9L.5A creating or restoring authorization does not deploy", async () => {

    const { dataDir, persistence } = createDiskPersistence();
    const logger = createLogger();
    const eventBus = createEventBus(logger);

    const emitted = [];

    for (const type of [
        EVENT_TYPES.DEPLOY_AUTHORIZATION_CREATED,
        EVENT_TYPES.DEPLOY_AUTHORIZATION_VALID,
        EVENT_TYPES.DEPLOY_AUTHORIZATION_CONSUMED,
        EVENT_TYPES.GAME_CONTRACT_DEPLOYED,
        EVENT_TYPES.GAME_CONTRACT_UPDATED
    ]) {

        eventBus.subscribe(type, (envelope) => {

            emitted.push(envelope.type);

        });

    }

    const beginDeployCalls = [];

    const gameContractManager = {
        restoreContracts() {

            return { restored: 0 };

        },
        _beginDeploy(payload) {

            beginDeployCalls.push(payload);

        }
    };

    try {

        const writer = new DeploymentAuthorizationCoordinator({
            eventBus,
            persistence: new TonFinancialDeploymentAuthorizationPersistence(persistence)
        });

        const session = fullDepositSession({ roomId: "room-safe", gameId: "game-safe" });
        const created = writer.createFromDepositSession(session);

        writer.markValid(created.authorizationId);

        assert.ok(emitted.includes(EVENT_TYPES.DEPLOY_AUTHORIZATION_CREATED));
        assert.ok(emitted.includes(EVENT_TYPES.DEPLOY_AUTHORIZATION_VALID));
        assert.equal(beginDeployCalls.length, 0);
        assert.equal(
            persistence.listActive(TON_FINANCIAL_RECORD_TYPES.GAME_CONTRACT).length,
            0
        );

        persistence.shutdown({ checkpoint: false });

        const secondPersistence = reopenPersistence(dataDir);
        const restoreEvents = [];

        eventBus.subscribe(EVENT_TYPES.DEPLOY_AUTHORIZATION_VALID, (envelope) => {

            restoreEvents.push(envelope.type);

        });

        try {

            const restoredCoordinator = new DeploymentAuthorizationCoordinator({
                eventBus,
                persistence: new TonFinancialDeploymentAuthorizationPersistence(secondPersistence)
            });

            const recovery = new TonFinancialRecovery({
                logger,
                eventBus,
                financialPersistence: secondPersistence,
                deploymentAuthorizationCoordinator: restoredCoordinator,
                gameContractManager
            });

            recovery.initialize();

            const report = await recovery.recover({
                trigger: "server_restart",
                reason: "authorization_safety"
            });

            const restored = restoredCoordinator.getAuthorization(created.authorizationId);

            assert.equal(restored.status, DEPLOYMENT_AUTHORIZATION_STATUS.VALID);
            assert.equal(beginDeployCalls.length, 0);
            assert.equal(
                secondPersistence.listActive(TON_FINANCIAL_RECORD_TYPES.GAME_CONTRACT).length,
                0
            );
            assert.equal(restoreEvents.length, 0);
            assert.equal(emitted.includes(EVENT_TYPES.GAME_CONTRACT_DEPLOYED), false);
            assert.ok(report.warnings.some((warning) => (
                warning.startsWith("authorization_restore:restored=1")
            )));

        } finally {

            secondPersistence.shutdown({ checkpoint: false });

        }

    } finally {

        eventBus.shutdown();
        TonFinancialPersistence.destroyStorage(dataDir);

    }

});

test("R17.9L.5A coordinator consume and revoke are durable and terminal", () => {

    const { dataDir, persistence } = createDiskPersistence();

    try {

        const coordinator = new DeploymentAuthorizationCoordinator({
            persistence: new TonFinancialDeploymentAuthorizationPersistence(persistence)
        });

        const consumed = coordinator.createFromDepositSession(
            fullDepositSession({ roomId: "room-cons", gameId: "game-cons" })
        );

        coordinator.markValid(consumed.authorizationId);
        coordinator.consume(consumed.authorizationId);

        assert.equal(consumed.status, DEPLOYMENT_AUTHORIZATION_STATUS.CONSUMED);

        const loaded = persistence.loadDeploymentAuthorization(consumed.authorizationId);

        assert.equal(loaded.status, DEPLOYMENT_AUTHORIZATION_STATUS.CONSUMED);
        assert.equal(loaded.immutable, true);

        const revoked = coordinator.createFromDepositSession(
            fullDepositSession({ roomId: "room-rev", gameId: "game-rev" })
        );

        coordinator.markValid(revoked.authorizationId);
        coordinator.revoke(revoked.authorizationId);

        persistence.shutdown({ checkpoint: false });

        const secondPersistence = reopenPersistence(dataDir);

        try {

            const second = new DeploymentAuthorizationCoordinator({
                persistence: new TonFinancialDeploymentAuthorizationPersistence(secondPersistence)
            });

            const summary = second.restoreActiveAuthorizations();

            assert.equal(summary.restored, 1);
            assert.equal(summary.skipped, 1);
            assert.equal(
                second.getAuthorization(consumed.authorizationId).status,
                DEPLOYMENT_AUTHORIZATION_STATUS.CONSUMED
            );
            assert.equal(second.getAuthorization(revoked.authorizationId), null);

        } finally {

            secondPersistence.shutdown({ checkpoint: false });

        }

    } finally {

        TonFinancialPersistence.destroyStorage(dataDir);

    }

});

console.log("deploymentAuthorization.r179l5a.test.js: all assertions passed");
