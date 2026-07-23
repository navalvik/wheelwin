import assert from "node:assert/strict";

import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { GameContractManager } from "../gameplay/GameContractManager.js";
import { GAME_CONTRACT_STATUS } from "../models/GameContract.js";
import { PAYMENT_PARTICIPANT_STATUS } from "../models/PaymentSession.js";

function createLogger() {

    return {
        info() {},
        error() {},
        warn() {},
        debug() {}
    };

}

function createHarness() {

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

    const playerManager = {
        getIdentity(playerId) {

            return identities.get(playerId) ?? null;

        }
    };

    const roomManager = {
        getRoom(roomId) {

            if (roomId !== "room-1") {

                return null;

            }

            return { players: ["p1", "p2", "p3"] };

        }
    };

    const manager = new GameContractManager({
        logger,
        eventBus,
        playerManager,
        roomManager,
        sessionWalletStore: {
            getWallet() {

                return "EQwallet";

            }
        },
        configurationEngine: {
            getConfiguration() {

                return {
                    stake: 10,
                    players: [],
                    sectors: []
                };

            }
        },
        creatingDelayMs: 0,
        devMode: false
    });

    manager.initialize();

    return { eventBus, manager };

}

{
    const { eventBus, manager } = createHarness();

    const updates = [];

    eventBus.subscribe(EVENT_TYPES.GAME_CONTRACT_UPDATED, (envelope) => {

        updates.push(envelope.payload);

    });

    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.PAYMENT_SESSION_UPDATED,
        payload: {
            roomId: "room-1",
            gameId: "game-1",
            participants: [
                {
                    playerId: "p1",
                    status: PAYMENT_PARTICIPANT_STATUS.PAYMENT_REQUESTED
                },
                {
                    playerId: "p2",
                    status: PAYMENT_PARTICIPANT_STATUS.PAYMENT_REQUESTED
                },
                {
                    playerId: "p3",
                    status: PAYMENT_PARTICIPANT_STATUS.PAYMENT_REQUESTED
                }
            ]
        }
    });

    const contract = manager.getContract("room-1");

    assert.ok(contract, "contract created after PAYMENT_REQUESTED");

    assert.equal(manager.getContractByGameId("game-1"), contract);

    assert.equal(
        contract.status,
        GAME_CONTRACT_STATUS.AWAITING_PAYMENTS
    );

    assert.ok(contract.snapshot, "immutable snapshot stored server-side");

    assert.ok(
        updates.every((update) => update.snapshot === undefined),
        "clients receive identifier + state only"
    );

    assert.ok(
        updates.some(
            (update) => update.status === GAME_CONTRACT_STATUS.CREATING
        )
    );

    assert.ok(
        updates.some(
            (update) => update.status === GAME_CONTRACT_STATUS.AWAITING_PAYMENTS
        )
    );

    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.PAYMENT_SESSION_COMPLETED,
        payload: { roomId: "room-1", gameId: "game-1" }
    });

    assert.equal(
        contract.status,
        GAME_CONTRACT_STATUS.READY_FOR_BLOCKCHAIN
    );

    manager.destroyContract("room-1");

    assert.equal(manager.getContract("room-1"), null);

    manager.shutdown();

    eventBus.shutdown();

}

console.log("gameContract.manager.test.js: all assertions passed");
