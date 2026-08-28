/**
 * R17.9L.18 — Legacy Game-deploy trigger isolation.
 *
 * Payment events must not invoke GameContractManager._beginDeploy at all.
 * Authorization throwing after a legacy trigger is NOT acceptable.
 * VALID DeploymentAuthorization → createContractRequest remains the
 * legitimate mocked deploy path (R18-S15: via DEPLOY_AUTHORIZATION_VALID).
 * No real TON.
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
import { DeploymentAuthorizationCoordinator } from "../deposit/DeploymentAuthorizationCoordinator.js";
import { DEPLOYMENT_AUTHORIZATION_STATUS } from "../deposit/DeploymentAuthorizationStates.js";
import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { GameContractManager } from "../gameplay/GameContractManager.js";
import { PaymentSessionManager } from "../gameplay/PaymentSessionManager.js";
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

function emitPaymentSessionUpdated(eventBus, {
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

function createIsolationStack({
    rooms = [{ roomId: "room-1", gameId: "game-1" }],
    authorize = false
} = {}) {

    OwnerConfiguration.resetForTests();

    OwnerConfiguration.load({ configPath: OWNER_CONFIG_EXAMPLE_PATH });

    const logger = createLogger();

    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    const roomById = new Map(
        rooms.map((room) => [room.roomId, room])
    );

    const authorizationCreated = [];

    eventBus.subscribe(EVENT_TYPES.DEPLOY_AUTHORIZATION_CREATED, (envelope) => {

        authorizationCreated.push(envelope.payload);

    });

    const authorizationCoordinator = new DeploymentAuthorizationCoordinator({
        eventBus
    });

    if (authorize) {

        for (const room of rooms) {

            issueValidDeploymentAuthorization(authorizationCoordinator, {
                roomId: room.roomId,
                gameId: room.gameId,
                network: "testnet"
            });

        }

    }

    const broadcastCalls = [];

    const deployCalls = [];

    const tonService = {
        async broadcastTransaction(boc) {

            broadcastCalls.push(boc);

            return { ok: true, boc };

        }
    };

    const deployAdapter = {
        async deploy(payload) {

            deployCalls.push(payload);

            await tonService.broadcastTransaction("mock-boc");

            return {
                ok: true,
                contractAddress: `EQ${payload?.roomId ?? "l18"}`,
                deploymentTxId: `tx-${payload?.roomId ?? "l18"}`,
                deployedAt: Date.now()
            };

        }
    };

    const identities = {
        p1: { nickname: "A", baseStake: 10, sectorCount: 1 },
        p2: { nickname: "B", baseStake: 10, sectorCount: 1 },
        p3: { nickname: "C", baseStake: 10, sectorCount: 1 }
    };

    const playerManager = {
        getIdentity(playerId) {

            return identities[playerId] ?? null;

        }
    };

    const roomManager = {
        getRoom(roomId) {

            return roomById.has(roomId)
                ? { players: ["p1", "p2", "p3"] }
                : null;

        }
    };

    const sessionWalletStore = {
        getWallet() {

            return "EQwallet";

        }
    };

    const gameContractManager = new GameContractManager({
        logger,
        eventBus,
        playerManager,
        roomManager,
        sessionWalletStore,
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

    gameContractManager.initialize();

    const paymentSessionManager = new PaymentSessionManager({
        logger,
        eventBus,
        playerManager,
        roomManager,
        roomConfig: { paymentSessionDurationMs: 60_000 },
        gameplayContextResolver: {
            resolveGameIdByRoomId(roomId) {

                return roomById.get(roomId)?.gameId ?? null;

            }
        },
        sessionWalletStore,
        gameContractManager,
        tonNetwork: "testnet",
        devMode: false
    });

    paymentSessionManager.initialize();

    const beginDeployCalls = spyMethod(gameContractManager, "_beginDeploy");

    const createContractRequestCalls = spyMethod(
        gameContractManager,
        "createContractRequest"
    );

    const consumeCalls = spyMethod(
        authorizationCoordinator,
        "consumeValidForDeploy"
    );

    const createAuthorizationCalls = spyMethod(
        authorizationCoordinator,
        "createFromDepositSession"
    );

    return {
        eventBus,
        gameContractManager,
        paymentSessionManager,
        authorizationCoordinator,
        beginDeployCalls,
        createContractRequestCalls,
        consumeCalls,
        createAuthorizationCalls,
        authorizationCreated,
        deployCalls,
        broadcastCalls,
        shutdown() {

            paymentSessionManager.shutdown();

            gameContractManager.shutdown();

            eventBus.shutdown();

        }
    };

}

function assertNoDeploymentTrigger(stack, { roomId = "room-1", gameId = "game-1" } = {}) {

    assert.equal(
        stack.beginDeployCalls.length,
        0,
        "GameContractManager._beginDeploy must not be invoked"
    );

    assert.equal(
        stack.createContractRequestCalls.length,
        0,
        "createContractRequest must not be invoked from payment events"
    );

    assert.equal(stack.deployCalls.length, 0);

    assert.equal(
        stack.broadcastCalls.length,
        0,
        "TonService.broadcastTransaction must not be invoked"
    );

    assert.equal(stack.consumeCalls.length, 0);

    assert.equal(stack.createAuthorizationCalls.length, 0);

    assert.equal(stack.authorizationCreated.length, 0);

    assert.equal(stack.gameContractManager.getContract(roomId), null);

    assert.equal(
        stack.authorizationCoordinator.getByRoomAndGame(roomId, gameId),
        null
    );

}

test("R17.9L.18 source has no payment-session deploy handler", () => {

    assert.equal(GCM_SOURCE.includes("this._handlePaymentSessionUpdated"), false);

    assert.equal(GCM_SOURCE.includes("PAYMENT_SESSION_UPDATED_TRIGGER"), false);

    assert.doesNotMatch(GCM_SOURCE, /EVENT_TYPES\.PAYMENT_SESSION_UPDATED/);

    assert.match(GCM_SOURCE, /async _beginDeploy\(/);

});

test("R17.9L.18 PAYMENT_SESSION_UPDATED cannot start deployment", async () => {

    const stack = createIsolationStack();

    emitPaymentSessionUpdated(stack.eventBus);

    await wait(20);

    assertNoDeploymentTrigger(stack);

    stack.shutdown();

});

test("R17.9L.18 PAYMENT_REQUESTED cannot start deployment", async () => {

    const stack = createIsolationStack();

    stack.eventBus.emit({
        source: "test",
        type: EVENT_TYPES.PAYMENT_CONNECTION_READY,
        payload: { roomId: "room-1", gameId: "game-1" }
    });

    await wait(20);

    const session = stack.paymentSessionManager.getSession("room-1");

    assert.ok(session);

    assert.ok(
        session.participants.every(
            (participant) => participant.status === PAYMENT_PARTICIPANT_STATUS.PAYMENT_REQUESTED
        )
    );

    assertNoDeploymentTrigger(stack);

    stack.shutdown();

});

test("R17.9L.18 payment events cannot create DeploymentAuthorization", async () => {

    const stack = createIsolationStack();

    stack.eventBus.emit({
        source: "test",
        type: EVENT_TYPES.PAYMENT_CONNECTION_READY,
        payload: { roomId: "room-1", gameId: "game-1" }
    });

    emitPaymentSessionUpdated(stack.eventBus);

    stack.eventBus.emit({
        source: "test",
        type: EVENT_TYPES.PAYMENT_REQUEST,
        payload: {
            roomId: "room-1",
            gameId: "game-1",
            playerId: "p1"
        }
    });

    await wait(20);

    assert.equal(stack.authorizationCreated.length, 0);

    assert.equal(stack.createAuthorizationCalls.length, 0);

    assert.equal(
        stack.authorizationCoordinator.getByRoomAndGame("room-1", "game-1"),
        null
    );

    assert.equal(stack.authorizationCoordinator._authorizations.size, 0);

    assertNoDeploymentTrigger(stack);

    stack.shutdown();

});

test("R17.9L.18 bot abandonment spends 0 TON and deploys nothing", async () => {

    const stack = createIsolationStack();

    stack.eventBus.emit({
        source: "test",
        type: EVENT_TYPES.ROOM_CREATED,
        payload: { roomId: "room-1", gameId: "game-1" }
    });

    for (const playerId of ["p1", "p2", "p3"]) {

        stack.eventBus.emit({
            source: "test",
            type: EVENT_TYPES.WALLET_VERIFIED,
            payload: { roomId: "room-1", playerId, walletAddress: "EQwallet" }
        });

    }

    stack.eventBus.emit({
        source: "test",
        type: EVENT_TYPES.PAYMENT_CONNECTION_READY,
        payload: { roomId: "room-1", gameId: "game-1" }
    });

    await wait(20);

    assert.ok(stack.paymentSessionManager.getSession("room-1"));

    stack.eventBus.emit({
        source: "test",
        type: EVENT_TYPES.ROOM_DESTROYED,
        payload: { roomId: "room-1" }
    });

    await wait(10);

    assertNoDeploymentTrigger(stack);

    assert.equal(stack.broadcastCalls.length, 0);

    stack.shutdown();

});

test("R17.9L.18 100 abandoned rooms spend 0 TON and create 0 authorizations", async () => {

    const rooms = Array.from({ length: 100 }, (_, index) => ({
        roomId: `room-${index + 1}`,
        gameId: `game-${index + 1}`
    }));

    const stack = createIsolationStack({ rooms });

    for (const room of rooms) {

        stack.eventBus.emit({
            source: "test",
            type: EVENT_TYPES.ROOM_CREATED,
            payload: room
        });

        stack.eventBus.emit({
            source: "test",
            type: EVENT_TYPES.PAYMENT_CONNECTION_READY,
            payload: room
        });

        emitPaymentSessionUpdated(stack.eventBus, room);

        stack.eventBus.emit({
            source: "test",
            type: EVENT_TYPES.ROOM_DESTROYED,
            payload: { roomId: room.roomId }
        });

    }

    await wait(50);

    assert.equal(stack.beginDeployCalls.length, 0);

    assert.equal(stack.createContractRequestCalls.length, 0);

    assert.equal(stack.deployCalls.length, 0);

    assert.equal(stack.broadcastCalls.length, 0);

    assert.equal(stack.authorizationCreated.length, 0);

    assert.equal(stack.createAuthorizationCalls.length, 0);

    assert.equal(stack.authorizationCoordinator._authorizations.size, 0);

    for (const room of rooms) {

        assert.equal(stack.gameContractManager.getContract(room.roomId), null);

        assert.equal(
            stack.authorizationCoordinator.getByRoomAndGame(room.roomId, room.gameId),
            null
        );

    }

    stack.shutdown();

});

test("R17.9L.18 valid DeploymentAuthorization still deploys via GCM path", async () => {

    const stack = createIsolationStack();

    issueValidDeploymentAuthorization(stack.authorizationCoordinator, {
        roomId: "room-1",
        gameId: "game-1",
        network: "testnet"
    });

    await wait(20);

    const contract = stack.gameContractManager.getContract("room-1");

    assert.ok(contract);

    assert.equal(stack.createContractRequestCalls.length, 1);

    assert.equal(stack.beginDeployCalls.length, 1);

    assert.equal(stack.consumeCalls.length, 1);

    assert.equal(stack.deployCalls.length, 1);

    assert.equal(
        stack.gameContractManager.getContract("room-1").status,
        GAME_CONTRACT_STATUS.AWAITING_PLAYER_PAYMENTS
    );

    const authorization = stack.authorizationCoordinator.getByRoomAndGame(
        "room-1",
        "game-1"
    );

    assert.equal(authorization.status, DEPLOYMENT_AUTHORIZATION_STATUS.CONSUMED);

    stack.shutdown();

});
