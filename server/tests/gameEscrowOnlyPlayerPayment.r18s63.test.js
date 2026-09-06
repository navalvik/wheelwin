/**
 * R18-S63 — GameEscrow-only player payment (no Deposit / FundSeat).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { isGameEscrowOnlyPlayerPayment } from "../config/gameEscrowMode.js";
import { DepositOrchestrator } from "../deposit/DepositOrchestrator.js";
import { DeploymentAuthorizationCoordinator } from "../deposit/DeploymentAuthorizationCoordinator.js";
import { DEPLOYMENT_AUTHORIZATION_STATUS } from "../deposit/DeploymentAuthorizationStates.js";
import { GameEscrowDeploymentAuthorizationAutomation } from "../deposit/GameEscrowDeploymentAuthorizationAutomation.js";
import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function threeParticipants() {

    return [
        {
            playerId: "player-a",
            wallet: "EQ_wallet_a",
            requiredGram: 1
        },
        {
            playerId: "player-b",
            wallet: "EQ_wallet_b",
            requiredGram: 1
        },
        {
            playerId: "player-c",
            wallet: "EQ_wallet_c",
            requiredGram: 2.5
        }
    ];

}

function createLogger() {

    return {
        info() {},
        warn() {},
        error() {},
        debug() {}
    };

}

test("isGameEscrowOnlyPlayerPayment is true only for game mode", () => {

    assert.equal(isGameEscrowOnlyPlayerPayment("game"), true);
    assert.equal(isGameEscrowOnlyPlayerPayment("v4"), false);
    assert.equal(isGameEscrowOnlyPlayerPayment(null), false);

});

test("DepositOrchestrator skips session creation when gameEscrowOnlyPlayerPayment", async () => {

    const created = [];

    const orchestrator = new DepositOrchestrator({
        logger: createLogger(),
        depositSessionCoordinator: {
            createSession(input) {

                created.push(input);
                return input;

            },
            getByRoomAndGame() {

                return null;

            }
        },
        gameEscrowOnlyPlayerPayment: true
    });

    const result = await orchestrator.handlePaymentConnectionReady({
        roomId: "98SD"
    });

    assert.equal(result.skipped, true);
    assert.equal(result.reason, "game_escrow_only");
    assert.equal(created.length, 0);

});

test("PAYMENT_SESSION_CREATED mints VALID GameEscrow deploy authorization without Deposit", () => {

    const logger = createLogger();
    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    const session = {
        paymentSessionId: "pay_1",
        roomId: "room-eq",
        gameId: "game-eq",
        status: "WAITING_FOR_PAYMENTS",
        participants: threeParticipants()
    };

    const coordinator = new DeploymentAuthorizationCoordinator({ eventBus });
    const validEvents = [];

    eventBus.subscribe(EVENT_TYPES.DEPLOY_AUTHORIZATION_VALID, (envelope) => {

        validEvents.push(envelope.payload);

    });

    const automation = new GameEscrowDeploymentAuthorizationAutomation({
        logger,
        eventBus,
        paymentSessionManager: {
            getSession(roomId) {

                return roomId === "room-eq" ? session : null;

            }
        },
        deploymentAuthorizationCoordinator: coordinator,
        enabled: true
    });

    automation.initialize();

    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.PAYMENT_SESSION_CREATED,
        payload: {
            roomId: "room-eq",
            gameId: "game-eq"
        }
    });

    const authorization = coordinator.getByRoomAndGame("room-eq", "game-eq");

    assert.ok(authorization);
    assert.equal(authorization.status, DEPLOYMENT_AUTHORIZATION_STATUS.VALID);
    assert.equal(authorization.metadata.gameEscrowOnly, true);
    assert.equal(authorization.depositId, "game_escrow:game-eq");
    assert.equal(validEvents.length, 1);

    const consumed = coordinator.consumeValidForDeploy({
        roomId: "room-eq",
        gameId: "game-eq"
    });

    assert.equal(consumed.status, DEPLOYMENT_AUTHORIZATION_STATUS.CONSUMED);

    automation.shutdown();
    eventBus.shutdown();

});

test("GameEscrow deploy authorization is independent of which player created the room", () => {

    const sessionA = {
        paymentSessionId: "pay_a",
        roomId: "room-a",
        gameId: "game-a",
        participants: threeParticipants()
    };

    const sessionB = {
        paymentSessionId: "pay_b",
        roomId: "room-b",
        gameId: "game-b",
        participants: [
            threeParticipants()[2],
            threeParticipants()[0],
            threeParticipants()[1]
        ]
    };

    const coordinatorA = new DeploymentAuthorizationCoordinator();
    const coordinatorB = new DeploymentAuthorizationCoordinator();

    const authA = coordinatorA.createFromGameEscrowReady(sessionA);
    const authB = coordinatorB.createFromGameEscrowReady(sessionB);

    assert.equal(authA.metadata.gameEscrowOnly, true);
    assert.equal(authB.metadata.gameEscrowOnly, true);
    assert.equal(authA.depositStateSnapshot.bindings.length, 3);
    assert.equal(authB.depositStateSnapshot.bindings.length, 3);
    assert.equal(
        authA.depositStateSnapshot.bindings.every((binding) => binding.expectedAmount !== 0.011),
        true
    );

});

test("app.js wires GameEscrow-only skip and authorization without Deposit package", () => {

    const appSource = readFileSync(join(HERE, "../app.js"), "utf8");
    const gsaSource = readFileSync(join(HERE, "../gameplay/GameStartAuthorization.js"), "utf8");
    const orchestratorSource = readFileSync(
        join(HERE, "../deposit/DepositOrchestrator.js"),
        "utf8"
    );

    assert.match(appSource, /GameEscrowDeploymentAuthorizationAutomation/);
    assert.match(appSource, /gameEscrowOnlyPlayerPayment:\s*isGameEscrowOnlyPlayerPayment/);
    assert.match(appSource, /gameEscrowMode:\s*this\._tonConfig\?\.gameEscrowMode/);
    assert.match(gsaSource, /_isGameEscrowOnlyPlayerPayment/);
    assert.match(gsaSource, /deposit_not_full/);
    assert.match(orchestratorSource, /game_escrow_only/);

});
