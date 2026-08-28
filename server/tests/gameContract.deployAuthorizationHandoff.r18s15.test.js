/**
 * R18-S15 — Production handoff:
 * DEPLOY_AUTHORIZATION_VALID → GameContractManager.createContractRequest.
 *
 * Does not consume authorization here. consumeValidForDeploy remains the
 * _beginDeploy spend gate. No real TON.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
    OWNER_CONFIG_EXAMPLE_PATH,
    OwnerConfiguration
} from "../config/OwnerConfiguration.js";
import { DepositSession } from "../deposit/DepositSession.js";
import { DeploymentAuthorizationCoordinator } from "../deposit/DeploymentAuthorizationCoordinator.js";
import { DEPLOYMENT_AUTHORIZATION_STATUS } from "../deposit/DeploymentAuthorizationStates.js";
import { EventBus } from "../events/EventBus.js";
import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { GameContractManager } from "../gameplay/GameContractManager.js";
import { GAME_CONTRACT_STATUS } from "../models/GameContract.js";
import { PAYMENT_PARTICIPANT_STATUS } from "../models/PaymentSession.js";
import { issueValidDeploymentAuthorization } from "./helpers/issueValidDeploymentAuthorization.js";

const GCM_SOURCE_PATH = join(
    dirname(fileURLToPath(import.meta.url)),
    "../gameplay/GameContractManager.js"
);

const GCM_SOURCE = readFileSync(GCM_SOURCE_PATH, "utf8");

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

function spyMethod(target, methodName) {

    const calls = [];

    const original = target[methodName];

    target[methodName] = function (...args) {

        calls.push(args);

        return original.apply(this, args);

    };

    return calls;

}

function createHandoffStack() {

    OwnerConfiguration.resetForTests();

    OwnerConfiguration.load({ configPath: OWNER_CONFIG_EXAMPLE_PATH });

    const logger = createLogger();

    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    const authorizationCoordinator = new DeploymentAuthorizationCoordinator({
        eventBus
    });

    const deployCalls = [];

    const deployAdapter = {
        async deploy(payload) {

            deployCalls.push(payload);

            return {
                ok: true,
                contractAddress: `EQ${payload?.roomId ?? "handoff"}`,
                deploymentTxId: `tx-${payload?.roomId ?? "handoff"}`,
                deployedAt: Date.now()
            };

        }
    };

    const identities = {
        p1: { nickname: "A", baseStake: 10, sectorCount: 1 },
        p2: { nickname: "B", baseStake: 10, sectorCount: 1 },
        p3: { nickname: "C", baseStake: 10, sectorCount: 1 }
    };

    const gameContractManager = new GameContractManager({
        logger,
        eventBus,
        playerManager: {
            getIdentity(playerId) {

                return identities[playerId] ?? null;

            }
        },
        roomManager: {
            getRoom(roomId) {

                return roomId === "room-1"
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
        deployAdapter,
        deploymentAuthorizationCoordinator: authorizationCoordinator,
        tonNetwork: "testnet",
        creatingDelayMs: 0,
        devMode: false
    });

    const createContractRequestCalls = spyMethod(
        gameContractManager,
        "createContractRequest"
    );

    const consumeCalls = spyMethod(
        authorizationCoordinator,
        "consumeValidForDeploy"
    );

    gameContractManager.initialize();

    return {
        eventBus,
        gameContractManager,
        authorizationCoordinator,
        createContractRequestCalls,
        consumeCalls,
        deployCalls,
        shutdown() {

            gameContractManager.shutdown();

            eventBus.shutdown();

        }
    };

}

test("R18-S15 source subscribes VALID and does not use payment events", () => {

    assert.match(GCM_SOURCE, /EVENT_TYPES\.DEPLOY_AUTHORIZATION_VALID/);

    assert.match(GCM_SOURCE, /_handleDeploymentAuthorizationValid/);

    assert.doesNotMatch(GCM_SOURCE, /EVENT_TYPES\.PAYMENT_SESSION_UPDATED/);

    assert.equal(GCM_SOURCE.includes("this._handlePaymentSessionUpdated"), false);

});

test("R18-S15 A: DEPLOY_AUTHORIZATION_VALID triggers createContractRequest", async () => {

    const stack = createHandoffStack();

    issueValidDeploymentAuthorization(stack.authorizationCoordinator, {
        roomId: "room-1",
        gameId: "game-1",
        network: "testnet"
    });

    await wait(20);

    assert.equal(stack.createContractRequestCalls.length, 1);

    assert.equal(stack.createContractRequestCalls[0][0], "room-1");

    assert.equal(stack.createContractRequestCalls[0][1]?.gameId, "game-1");

    const contract = stack.gameContractManager.getContract("room-1");

    assert.ok(contract);

    assert.equal(contract.gameId, "game-1");

    assert.equal(contract.status, GAME_CONTRACT_STATUS.AWAITING_PLAYER_PAYMENTS);

    assert.equal(stack.consumeCalls.length, 1);

    assert.equal(stack.deployCalls.length, 1);

    const authorization = stack.authorizationCoordinator.getByRoomAndGame(
        "room-1",
        "game-1"
    );

    assert.equal(authorization.status, DEPLOYMENT_AUTHORIZATION_STATUS.CONSUMED);

    stack.shutdown();

});

test("R18-S15 B: forged VALID event does not create or deploy", async () => {

    const stack = createHandoffStack();

    stack.eventBus.emit({
        source: EVENT_SOURCES.DEPLOYMENT_AUTHORIZATION_COORDINATOR,
        type: EVENT_TYPES.DEPLOY_AUTHORIZATION_VALID,
        payload: {
            authorizationId: "dauth_forged",
            roomId: "room-1",
            gameId: "game-1",
            status: DEPLOYMENT_AUTHORIZATION_STATUS.VALID
        }
    });

    await wait(20);

    assert.equal(stack.createContractRequestCalls.length, 0);

    assert.equal(stack.consumeCalls.length, 0);

    assert.equal(stack.deployCalls.length, 0);

    assert.equal(stack.gameContractManager.getContract("room-1"), null);

    stack.shutdown();

});

test("R18-S15 B: CREATED authorization is not a deploy trigger", async () => {

    const stack = createHandoffStack();

    const session = new DepositSession({
        roomId: "room-1",
        gameId: "game-1",
        metadata: { network: "testnet" }
    });

    session.bindPlayers([
        { playerId: "p1", wallet: "EQ_wallet_1", expectedAmount: 10 },
        { playerId: "p2", wallet: "EQ_wallet_2", expectedAmount: 10 },
        { playerId: "p3", wallet: "EQ_wallet_3", expectedAmount: 10 }
    ]);
    session.markAwaitingFunds();
    session.applyFunding({ wallet: "EQ_wallet_1", amount: 10, fundingEventId: "tx-1" });
    session.applyFunding({ wallet: "EQ_wallet_2", amount: 10, fundingEventId: "tx-2" });
    session.applyFunding({ wallet: "EQ_wallet_3", amount: 10, fundingEventId: "tx-3" });

    stack.authorizationCoordinator.createFromDepositSession(session, {
        network: "testnet"
    });

    stack.eventBus.emit({
        source: EVENT_SOURCES.DEPLOYMENT_AUTHORIZATION_COORDINATOR,
        type: EVENT_TYPES.DEPLOY_AUTHORIZATION_VALID,
        payload: {
            roomId: "room-1",
            gameId: "game-1",
            status: DEPLOYMENT_AUTHORIZATION_STATUS.VALID
        }
    });

    await wait(20);

    assert.equal(
        stack.authorizationCoordinator.getByRoomAndGame("room-1", "game-1").status,
        DEPLOYMENT_AUTHORIZATION_STATUS.CREATED
    );

    assert.equal(stack.createContractRequestCalls.length, 0);

    assert.equal(stack.consumeCalls.length, 0);

    assert.equal(stack.deployCalls.length, 0);

    assert.equal(stack.gameContractManager.getContract("room-1"), null);

    stack.shutdown();

});

test("R18-S15 C: duplicate VALID event does not create a second contract", async () => {

    const stack = createHandoffStack();

    const authorization = issueValidDeploymentAuthorization(
        stack.authorizationCoordinator,
        {
            roomId: "room-1",
            gameId: "game-1",
            network: "testnet"
        }
    );

    await wait(20);

    const firstContract = stack.gameContractManager.getContract("room-1");

    assert.ok(firstContract);

    stack.eventBus.emit({
        source: EVENT_SOURCES.DEPLOYMENT_AUTHORIZATION_COORDINATOR,
        type: EVENT_TYPES.DEPLOY_AUTHORIZATION_VALID,
        payload: {
            authorizationId: authorization.authorizationId,
            roomId: "room-1",
            gameId: "game-1",
            status: DEPLOYMENT_AUTHORIZATION_STATUS.VALID
        }
    });

    await wait(20);

    assert.equal(stack.createContractRequestCalls.length, 1);

    assert.equal(stack.deployCalls.length, 1);

    assert.equal(stack.consumeCalls.length, 1);

    assert.equal(
        stack.gameContractManager.getContract("room-1").contractId,
        firstContract.contractId
    );

    stack.shutdown();

});

test("R18-S15 D: payment events are not an alternative deploy trigger", async () => {

    const stack = createHandoffStack();

    stack.eventBus.emit({
        source: "test",
        type: EVENT_TYPES.PAYMENT_CONNECTION_READY,
        payload: { roomId: "room-1", gameId: "game-1" }
    });

    stack.eventBus.emit({
        source: "test",
        type: EVENT_TYPES.PAYMENT_SESSION_UPDATED,
        payload: {
            roomId: "room-1",
            gameId: "game-1",
            participants: [
                { playerId: "p1", status: PAYMENT_PARTICIPANT_STATUS.PAYMENT_REQUESTED },
                { playerId: "p2", status: PAYMENT_PARTICIPANT_STATUS.PAYMENT_REQUESTED },
                { playerId: "p3", status: PAYMENT_PARTICIPANT_STATUS.PAYMENT_REQUESTED }
            ]
        }
    });

    stack.eventBus.emit({
        source: "test",
        type: EVENT_TYPES.PAYMENT_REQUEST,
        payload: { roomId: "room-1", gameId: "game-1", playerId: "p1" }
    });

    await wait(20);

    assert.equal(stack.createContractRequestCalls.length, 0);

    assert.equal(stack.consumeCalls.length, 0);

    assert.equal(stack.deployCalls.length, 0);

    assert.equal(stack.gameContractManager.getContract("room-1"), null);

    stack.shutdown();

});
