/**
 * R17.9L.5B — GameContractManager deployment authorization gate tests.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
    OWNER_CONFIG_EXAMPLE_PATH,
    OwnerConfiguration
} from "../config/OwnerConfiguration.js";
import { DeploymentAuthorizationCoordinator } from "../deposit/DeploymentAuthorizationCoordinator.js";
import { DEPLOYMENT_AUTHORIZATION_STATUS } from "../deposit/DeploymentAuthorizationStates.js";
import { TonFinancialDeploymentAuthorizationPersistence } from "../deposit/DeploymentAuthorizationPersistencePort.js";
import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import {
    GameContractManager,
    MissingDeploymentAuthorizationError
} from "../gameplay/GameContractManager.js";
import { GAME_CONTRACT_STATUS } from "../models/GameContract.js";
import { PAYMENT_PARTICIPANT_STATUS } from "../models/PaymentSession.js";
import { TonFinancialPersistence } from "../persistence/TonFinancialPersistence.js";
import { TonFinancialRecovery } from "../recovery/TonFinancialRecovery.js";
import { issueValidDeploymentAuthorization } from "./helpers/issueValidDeploymentAuthorization.js";

function createLogger() {

    return {
        info() {},
        warn() {},
        error() {},
        debug() {},
        decisionTrace() {}
    };

}

function wait(ms) {

    return new Promise((resolve) => setTimeout(resolve, ms));

}

function emitPaymentRequested(eventBus, {
    roomId = "room-1",
    gameId = "game-1"
} = {}) {

    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.PAYMENT_SESSION_UPDATED,
        payload: {
            roomId,
            gameId,
            participants: [
                { playerId: "p1", status: PAYMENT_PARTICIPANT_STATUS.PAYMENT_REQUESTED },
                { playerId: "p2", status: PAYMENT_PARTICIPANT_STATUS.PAYMENT_REQUESTED },
                { playerId: "p3", status: PAYMENT_PARTICIPANT_STATUS.PAYMENT_REQUESTED }
            ]
        }
    });

}

function createManager({
    eventBus,
    authorizationCoordinator,
    deployAdapter = null,
    financialPersistence = null,
    tonNetwork = "testnet",
    creatingDelayMs = 0
} = {}) {

    OwnerConfiguration.resetForTests();

    OwnerConfiguration.load({ configPath: OWNER_CONFIG_EXAMPLE_PATH });

    const logger = createLogger();

    const bus = eventBus ?? new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    if (!eventBus) {

        bus.initialize();

    }

    const manager = new GameContractManager({
        logger,
        eventBus: bus,
        playerManager: {
            getIdentity(playerId) {

                return {
                    p1: { nickname: "A", baseStake: 10, sectorCount: 1 },
                    p2: { nickname: "B", baseStake: 10, sectorCount: 1 },
                    p3: { nickname: "C", baseStake: 10, sectorCount: 1 }
                }[playerId] ?? null;

            }
        },
        roomManager: {
            getRoom(roomId) {

                return roomId === "room-1" || roomId === "room-a" || roomId === "room-b"
                    ? { players: ["p1", "p2", "p3"] }
                    : null;

            }
        },
        sessionWalletStore: {
            getWallet() {

                return "EQwallet";

            }
        },
        configurationEngine: {
            getConfiguration() {

                return { stake: 10, players: [], sectors: [] };

            }
        },
        deployAdapter: deployAdapter ?? {
            async deploy() {

                return {
                    ok: true,
                    contractAddress: "EQauthorized",
                    deploymentTxId: "tx-auth",
                    deployedAt: Date.now()
                };

            }
        },
        financialPersistence,
        deploymentAuthorizationCoordinator: authorizationCoordinator,
        tonNetwork,
        creatingDelayMs,
        devMode: false
    });

    manager.initialize();

    return { eventBus: bus, manager, logger };

}

test("R17.9L.5B unfunded deployment blocked without authorization", async () => {

    const authorizationCoordinator = new DeploymentAuthorizationCoordinator();
    const { eventBus, manager } = createManager({ authorizationCoordinator });

    const deployCalls = [];

    manager._deployAdapter = {
        async deploy(payload) {

            deployCalls.push(payload);

            return {
                ok: true,
                contractAddress: "EQblocked",
                deploymentTxId: "tx-blocked",
                deployedAt: Date.now()
            };

        }
    };

    emitPaymentRequested(eventBus);

    await wait(20);

    assert.equal(deployCalls.length, 0);

    const contract = manager.getContract("room-1");

    assert.ok(contract);
    assert.equal(contract.status, GAME_CONTRACT_STATUS.READY_FOR_BLOCKCHAIN);

    eventBus.shutdown();

});

test("R17.9L.5B valid authorization allows deploy", async () => {

    const authorizationCoordinator = new DeploymentAuthorizationCoordinator();

    issueValidDeploymentAuthorization(authorizationCoordinator, {
        roomId: "room-1",
        gameId: "game-1"
    });

    const { eventBus, manager } = createManager({ authorizationCoordinator });

    const deployCalls = [];

    manager._deployAdapter = {
        async deploy(payload) {

            deployCalls.push(payload);

            return {
                ok: true,
                contractAddress: "EQallowed",
                deploymentTxId: "tx-allowed",
                deployedAt: Date.now()
            };

        }
    };

    emitPaymentRequested(eventBus);

    await wait(20);

    assert.equal(deployCalls.length, 1);

    assert.equal(
        manager.getContract("room-1").status,
        GAME_CONTRACT_STATUS.AWAITING_PLAYER_PAYMENTS
    );

    const authorization = authorizationCoordinator.getByRoomAndGame("room-1", "game-1");

    assert.equal(authorization.status, DEPLOYMENT_AUTHORIZATION_STATUS.CONSUMED);

    eventBus.shutdown();

});

test("R17.9L.5B wrong room authorization is rejected", async () => {

    const authorizationCoordinator = new DeploymentAuthorizationCoordinator();

    issueValidDeploymentAuthorization(authorizationCoordinator, {
        roomId: "room-a",
        gameId: "game-a"
    });

    const { manager } = createManager({
        authorizationCoordinator,
        creatingDelayMs: 60_000
    });

    const contract = manager.createContractRequest("room-1", { gameId: "game-1" });

    manager._clearCreatingTimer("room-1");

    contract.status = GAME_CONTRACT_STATUS.READY_FOR_BLOCKCHAIN;

    await assert.rejects(
        () => manager.deployContract("room-1"),
        (error) => error instanceof MissingDeploymentAuthorizationError
    );

});

test("R17.9L.5B consumed authorization is rejected", async () => {

    const authorizationCoordinator = new DeploymentAuthorizationCoordinator();

    const authorization = issueValidDeploymentAuthorization(authorizationCoordinator, {
        roomId: "room-1",
        gameId: "game-1"
    });

    authorizationCoordinator.consume(authorization.authorizationId);

    const { manager } = createManager({
        authorizationCoordinator,
        creatingDelayMs: 60_000
    });

    const contract = manager.createContractRequest("room-1", { gameId: "game-1" });

    manager._clearCreatingTimer("room-1");

    contract.status = GAME_CONTRACT_STATUS.READY_FOR_BLOCKCHAIN;

    await assert.rejects(
        () => manager.deployContract("room-1"),
        (error) => error instanceof MissingDeploymentAuthorizationError
            && error.details?.reason === "consumed"
    );

});

test("R17.9L.5B concurrent deploy allows only one adapter call", async () => {

    const authorizationCoordinator = new DeploymentAuthorizationCoordinator();

    issueValidDeploymentAuthorization(authorizationCoordinator, {
        roomId: "room-1",
        gameId: "game-1"
    });

    const { eventBus, manager } = createManager({
        authorizationCoordinator,
        creatingDelayMs: 60_000
    });

    let deployCalls = 0;

    manager._deployAdapter = {
        async deploy() {

            deployCalls += 1;

            await wait(40);

            return {
                ok: true,
                contractAddress: "EQconcurrent",
                deploymentTxId: "tx-concurrent",
                deployedAt: Date.now()
            };

        }
    };

    const contract = manager.createContractRequest("room-1", { gameId: "game-1" });

    contract.status = GAME_CONTRACT_STATUS.READY_FOR_BLOCKCHAIN;

    const first = manager.deployContract("room-1");

    await assert.rejects(
        () => manager.deployContract("room-1"),
        (error) => error.code === "CONTRACT_OPERATION_IN_PROGRESS"
    );

    await first;

    assert.equal(deployCalls, 1);

    eventBus.shutdown();

});

test("R17.9L.5B restart with DEPOSIT_FULL does not auto-deploy", async () => {

    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-gcm-gate-recovery-"));

    const persistence = new TonFinancialPersistence({
        dataDir,
        autoCheckpoint: false
    });

    persistence.initialize();

    const authorizationCoordinator = new DeploymentAuthorizationCoordinator({
        persistence: new TonFinancialDeploymentAuthorizationPersistence(persistence)
    });

    issueValidDeploymentAuthorization(authorizationCoordinator, {
        roomId: "room-1",
        gameId: "game-1"
    });

    const { eventBus, manager, logger } = createManager({
        authorizationCoordinator,
        financialPersistence: persistence,
        creatingDelayMs: 60_000
    });

    emitPaymentRequested(eventBus);

    await wait(5);

    assert.equal(manager.getContract("room-1").status, GAME_CONTRACT_STATUS.CREATING);

    manager._clearCreatingTimer("room-1");
    manager.shutdown();

    persistence.shutdown({ checkpoint: false });

    const secondPersistence = new TonFinancialPersistence({
        dataDir,
        autoCheckpoint: false
    });

    secondPersistence.initialize();

    const restoredCoordinator = new DeploymentAuthorizationCoordinator({
        persistence: new TonFinancialDeploymentAuthorizationPersistence(secondPersistence)
    });

    const { manager: restoredManager } = createManager({
        eventBus,
        authorizationCoordinator: restoredCoordinator,
        financialPersistence: secondPersistence,
        creatingDelayMs: 60_000
    });

    const recovery = new TonFinancialRecovery({
        logger,
        eventBus,
        financialPersistence: secondPersistence,
        gameContractManager: restoredManager,
        deploymentAuthorizationCoordinator: restoredCoordinator
    });

    recovery.initialize();

    const deployCalls = [];

    restoredManager._deployAdapter = {
        async deploy(payload) {

            deployCalls.push(payload);

            return {
                ok: true,
                contractAddress: "EQrecovery",
                deploymentTxId: "tx-recovery",
                deployedAt: Date.now()
            };

        }
    };

    await recovery.recover({
        trigger: "server_restart",
        reason: "authorization_gate_safety"
    });

    await wait(20);

    assert.equal(deployCalls.length, 0);

    const restoredAuthorization = restoredCoordinator.getByRoomAndGame("room-1", "game-1");

    assert.equal(restoredAuthorization.status, DEPLOYMENT_AUTHORIZATION_STATUS.VALID);

    restoredManager._clearCreatingTimer("room-1");
    restoredManager.shutdown();
    recovery.shutdown();

    secondPersistence.shutdown({ checkpoint: false });

    TonFinancialPersistence.destroyStorage(dataDir);

    eventBus.shutdown();

});

console.log("gameContract.deploymentAuthorizationGate.r179l5b.test.js: all assertions passed");
