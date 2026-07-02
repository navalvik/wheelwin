import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { GAME_STATES } from "../engines/gameState/GameStates.js";
import { GameManager } from "../managers/GameManager.js";
import { PlayerManager } from "../managers/PlayerManager.js";
import { RoomManager } from "../managers/RoomManager.js";
import { LoggerService } from "../services/LoggerService.js";
import {
    shutdownGameplayBootstrap,
    wireGameplayBootstrap
} from "./helpers/gameplayBootstrapHarness.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

function collectEvents(eventBus, types) {

    const collected = [];

    const handlers = types.map((type) => {

        const handler = (envelope) => {

            collected.push({
                type: envelope.type,
                payload: envelope.payload
            });

        };

        eventBus.subscribe(type, handler);

        return { type, handler };

    });

    return {
        collected,
        cleanup() {

            for (const { type, handler } of handlers) {

                eventBus.unsubscribe(type, handler);

            }

        }
    };

}

function eventIndex(collected, type) {

    return collected.findIndex((entry) => entry.type === type);

}

const logger = new LoggerService({ logLevel: "error" });

logger.initialize();

const eventBus = new EventBus({
    logger,
    eventBusConfig: { logEvents: false, showDebugPanel: false }
});

eventBus.initialize();

const roomManager = new RoomManager({
    logger,
    eventBus,
    roomConfig: { maxPlayers: 3 }
});

const playerManager = new PlayerManager({ logger, eventBus });

const gameManager = new GameManager({ logger, eventBus });

roomManager.initialize();

playerManager.initialize();

gameManager.initialize();

const bootstrapEngines = wireGameplayBootstrap({
    gameManager,
    roomManager,
    playerManager,
    logger,
    eventBus,
    devMode: true
});

const events = collectEvents(eventBus, [
    EVENT_TYPES.GAME_CREATED,
    EVENT_TYPES.CONFIGURATION_READY,
    EVENT_TYPES.GAME_INITIALIZED
]);

const room = roomManager.createRoom();

const playerIds = ["player-1", "player-2", "player-3"];

for (const playerId of playerIds) {

    playerManager.createPlayer({ playerId });

    roomManager.addPlayer(room.roomId, playerId);

}

const createdIndex = eventIndex(events.collected, EVENT_TYPES.GAME_CREATED);

const configIndex = eventIndex(events.collected, EVENT_TYPES.CONFIGURATION_READY);

const initializedIndex = eventIndex(
    events.collected,
    EVENT_TYPES.GAME_INITIALIZED
);

assert(createdIndex >= 0, "GAME_CREATED should be emitted");

assert(configIndex >= 0, "CONFIGURATION_READY should be emitted");

assert(initializedIndex >= 0, "GAME_INITIALIZED should be emitted");

assert(
    createdIndex < configIndex && configIndex < initializedIndex,
    "bootstrap events should emit in lifecycle order"
);

const gameId = events.collected[initializedIndex].payload?.gameId;

assert(gameId, "GAME_INITIALIZED should include gameId");

assert(
    gameManager.hasGame(gameId),
    "GameManager should own the created game"
);

assert(
    bootstrapEngines.gameStateEngine.getHistory(gameId)[0].state === GAME_STATES.READY,
    "bootstrap should initialize authoritative GameState to READY"
);

for (const playerId of playerIds) {

    assert(
        bootstrapEngines.inputAuthority.getPlayerInputState(gameId, playerId),
        `player ${playerId} should be registered in InputAuthority`
    );

}

const simulation = bootstrapEngines.physicsEngine.getSimulation(gameId);

assert(simulation, "physics simulation should exist");

assert(
    simulation.runtime.angularVelocity === 0,
    "initial wheel velocity should remain zero"
);

assert(
    bootstrapEngines.gameClockEngine.isRunning(gameId),
    "GameClock should be running after bootstrap"
);

assert(
    bootstrapEngines.configurationEngine.getConfiguration(gameId),
    "configuration should be committed after bootstrap"
);

events.cleanup();

shutdownGameplayBootstrap(bootstrapEngines);

gameManager.shutdown();

playerManager.shutdown();

roomManager.shutdown();

eventBus.shutdown();

logger.shutdown();

console.log("gameplayBootstrap.integration.test.js: all assertions passed");
