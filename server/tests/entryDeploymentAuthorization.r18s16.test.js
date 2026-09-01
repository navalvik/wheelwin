/**
 * R18-S16 — Entry DeploymentAuthorization from deposit package (not DEPOSIT_FULL).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { DepositSession } from "../deposit/DepositSession.js";
import { DEPOSIT_SESSION_STATUS } from "../deposit/DepositSessionStates.js";
import { DeploymentAuthorizationCoordinator } from "../deposit/DeploymentAuthorizationCoordinator.js";
import { EntryDeploymentAuthorizationAutomation } from "../deposit/EntryDeploymentAuthorizationAutomation.js";
import { InvalidDeploymentAuthorizationError } from "../deposit/DeploymentAuthorizationErrors.js";
import { DEPLOYMENT_AUTHORIZATION_STATUS } from "../deposit/DeploymentAuthorizationStates.js";
import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";

const DEPOSIT_ADDRESS = "EQDS6oOJ0q-nM7pZnAwDF6PgUQPKc_stNX1WLp0qII1yTUdc";

function threePlayers() {

    return [
        { playerId: "p1", wallet: "EQ_wallet_1", expectedAmount: 10 },
        { playerId: "p2", wallet: "EQ_wallet_2", expectedAmount: 10 },
        { playerId: "p3", wallet: "EQ_wallet_3", expectedAmount: 10 }
    ];

}

function awaitingFundsSession({ roomId = "room-entry", gameId = "game-entry" } = {}) {

    const session = new DepositSession({
        roomId,
        gameId,
        metadata: { network: "testnet" }
    });

    session.bindPlayers(threePlayers());
    session.markAwaitingFunds();
    session.setDepositAddress(DEPOSIT_ADDRESS);

    return session;

}

function createLogger() {

    return {
        info() {},
        warn() {},
        error() {},
        debug() {},
        decisionTrace() {}
    };

}

test("R18-S16: AWAITING_FUNDS with deposit address can create entry authorization", () => {

    const session = awaitingFundsSession();

    assert.equal(session.state, DEPOSIT_SESSION_STATUS.AWAITING_FUNDS);

    const coordinator = new DeploymentAuthorizationCoordinator();
    const created = coordinator.createFromEntryReady(session);
    const valid = coordinator.markValid(created.authorizationId);

    assert.equal(valid.status, DEPLOYMENT_AUTHORIZATION_STATUS.VALID);
    assert.equal(valid.metadata.entryReady, true);
    assert.equal(valid.depositId, session.depositId);

});

test("R18-S16: CREATED deposit session cannot mint entry authorization", () => {

    const session = new DepositSession({
        roomId: "room-created",
        gameId: "game-created",
        metadata: { network: "testnet" }
    });

    const coordinator = new DeploymentAuthorizationCoordinator();

    assert.throws(
        () => coordinator.createFromEntryReady(session),
        InvalidDeploymentAuthorizationError
    );

});

test("R18-S16: DEPOSIT_PACKAGE_PUBLISHED marks entry authorization VALID once", () => {

    const session = awaitingFundsSession({
        roomId: "room-pkg",
        gameId: "game-pkg"
    });

    const logger = createLogger();
    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    const validEvents = [];

    eventBus.subscribe(EVENT_TYPES.DEPLOY_AUTHORIZATION_VALID, (envelope) => {

        validEvents.push(envelope);

    });

    const sessions = new Map([[session.depositId, session]]);
    const coordinator = new DeploymentAuthorizationCoordinator({ eventBus });
    const automation = new EntryDeploymentAuthorizationAutomation({
        logger,
        eventBus,
        depositSessionCoordinator: {
            getSession(depositId) {

                return sessions.get(depositId) ?? null;

            },
            restoreFromPersistence(depositId) {

                return sessions.get(depositId) ?? null;

            }
        },
        deploymentAuthorizationCoordinator: coordinator
    });

    automation.initialize();

    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.DEPOSIT_PACKAGE_PUBLISHED,
        payload: {
            depositId: session.depositId,
            roomId: session.roomId,
            gameId: session.gameId,
            depositAddress: DEPOSIT_ADDRESS
        }
    });

    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.DEPOSIT_PACKAGE_PUBLISHED,
        payload: {
            depositId: session.depositId,
            roomId: session.roomId,
            gameId: session.gameId,
            depositAddress: DEPOSIT_ADDRESS
        }
    });

    assert.equal(validEvents.length, 1);
    assert.equal(
        coordinator.getByRoomAndGame("room-pkg", "game-pkg").status,
        DEPLOYMENT_AUTHORIZATION_STATUS.VALID
    );

});
