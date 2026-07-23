import assert from "node:assert/strict";

import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { GameContractManager } from "../gameplay/GameContractManager.js";
import { GAME_CONTRACT_STATUS } from "../models/GameContract.js";
import { PAYMENT_PARTICIPANT_STATUS } from "../models/PaymentSession.js";
import { GameContractDeployAdapter } from "../payment/GameContractDeployAdapter.js";

function createLogger() {

    return {
        info() {},
        error() {},
        warn() {},
        debug() {}
    };

}

function wait(ms) {

    return new Promise((resolve) => setTimeout(resolve, ms));

}

function createHarness({ shouldFail = false } = {}) {

    const logger = createLogger();

    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    const identities = new Map([
        ["p1", { nickname: "A", baseStake: 10, sectorCount: 1 }],
        ["p2", { nickname: "B", baseStake: 10, sectorCount: 1 }],
        ["p3", { nickname: "C", baseStake: 10, sectorCount: 1 }]
    ]);

    const manager = new GameContractManager({
        logger,
        eventBus,
        playerManager: {
            getIdentity(playerId) {

                return identities.get(playerId) ?? null;

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
        deployAdapter: new GameContractDeployAdapter({
            deployDelayMs: 0,
            shouldFail
        }),
        creatingDelayMs: 0,
        devMode: false
    });

    manager.initialize();

    return { eventBus, manager };

}

{
    const { eventBus, manager } = createHarness();

    const updates = [];

    const readyForPayments = [];

    eventBus.subscribe(EVENT_TYPES.GAME_CONTRACT_UPDATED, (envelope) => {

        updates.push(envelope.payload);

    });

    eventBus.subscribe(EVENT_TYPES.GAME_CONTRACT_READY_FOR_PAYMENTS, (envelope) => {

        readyForPayments.push(envelope.payload);

    });

    eventBus.emit({
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

    await wait(10);

    const contract = manager.getContract("room-1");

    assert.ok(contract);

    assert.equal(
        contract.status,
        GAME_CONTRACT_STATUS.AWAITING_PLAYER_PAYMENTS
    );

    assert.ok(contract.contractAddress);

    assert.equal(readyForPayments.length, 1);

    assert.equal(
        readyForPayments[0].contractAddress,
        contract.contractAddress
    );

    assert.ok(
        updates.every((update) => update.snapshot === undefined),
        "clients never receive snapshot body"
    );

    assert.ok(
        updates.some((update) => update.contractAddress),
        "clients receive contractAddress after deploy"
    );

    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.PAYMENT_SESSION_COMPLETED,
        payload: { roomId: "room-1", gameId: "game-1" }
    });

    assert.equal(
        contract.status,
        GAME_CONTRACT_STATUS.PAYMENTS_COMPLETE
    );

    manager.shutdown();

    eventBus.shutdown();

}

{
    const { eventBus, manager } = createHarness({ shouldFail: true });

    const failed = [];

    eventBus.subscribe(EVENT_TYPES.GAME_CONTRACT_DEPLOY_FAILED, (envelope) => {

        failed.push(envelope.payload);

    });

    eventBus.emit({
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

    await wait(10);

    assert.equal(failed.length, 1);

    assert.equal(
        manager.getContract("room-1").status,
        GAME_CONTRACT_STATUS.DEPLOY_FAILED
    );

    manager.shutdown();

    eventBus.shutdown();

}

console.log("gameContract.manager.test.js: all assertions passed");
