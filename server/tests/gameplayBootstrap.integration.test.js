import { EventBus } from "../events/EventBus.js";
import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { GAME_STATES } from "../engines/gameState/GameStates.js";
import { GameManager } from "../managers/GameManager.js";
import { PlayerManager } from "../managers/PlayerManager.js";
import { RoomManager } from "../managers/RoomManager.js";
import { LoggerService } from "../services/LoggerService.js";
import {
    seedCompletePlayerProfiles,
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
    EVENT_TYPES.GAME_INITIALIZED,
    EVENT_TYPES.ENTRY_PAYMENT_COMPLETED
]);

const room = roomManager.createRoom();

const playerIds = ["player-1", "player-2", "player-3"];

seedCompletePlayerProfiles(playerManager, playerIds);

for (const playerId of playerIds) {

    roomManager.addPlayer(room.roomId, playerId);

}

const createdIndex = eventIndex(events.collected, EVENT_TYPES.GAME_CREATED);

const configIndex = eventIndex(events.collected, EVENT_TYPES.CONFIGURATION_READY);

assert(createdIndex >= 0, "GAME_CREATED should be emitted");

assert(configIndex >= 0, "CONFIGURATION_READY should be emitted");

assert(
    createdIndex < configIndex,
    "bootstrap prep events should emit in lifecycle order"
);

assert(
    eventIndex(events.collected, EVENT_TYPES.GAME_INITIALIZED) === -1,
    "GAME_INITIALIZED must wait for ENTRY_PAYMENT_COMPLETED"
);

const games = gameManager.getGames();

assert(games.length === 1, "GameManager should own the created game");

const gameId = games[0].gameId;

assert(
    bootstrapEngines.gameStateEngine.getState(gameId) === null,
    "GameState must not initialize before ENTRY_PAYMENT_COMPLETED"
);

assert(
    bootstrapEngines.gameClockEngine.isRunning(gameId) === false,
    "GameClock must not run before ENTRY_PAYMENT_COMPLETED"
);

const simulationBefore = bootstrapEngines.physicsEngine.getSimulation(gameId);

assert(simulationBefore, "physics simulation should exist after prep");

assert(
    simulationBefore.runtime?.running !== true
        && simulationBefore.runtime?.isRunning !== true,
    "physics must not be running before ENTRY_PAYMENT_COMPLETED"
);

// R1.1 — activate gameplay after entry payment.
eventBus.emit({
    source: EVENT_SOURCES.ROOM_LOBBY_BRIDGE,
    type: EVENT_TYPES.ENTRY_PAYMENT_COMPLETED,
    payload: { roomId: room.roomId }
});

const initializedIndex = eventIndex(
    events.collected,
    EVENT_TYPES.GAME_INITIALIZED
);

assert(initializedIndex >= 0, "GAME_INITIALIZED should be emitted");

assert(
    configIndex < initializedIndex,
    "GAME_INITIALIZED must follow configuration and entry payment"
);

assert(
    bootstrapEngines.gameStateEngine.getHistory(gameId)[0].state === GAME_STATES.PRE_GAME_READY,
    "activation should initialize authoritative GameState to PRE_GAME_READY"
);

for (const playerId of playerIds) {

    assert(
        bootstrapEngines.inputAuthority.getPlayerInputState(gameId, playerId),
        `player ${playerId} should be registered in InputAuthority`
    );

}

assert(
    bootstrapEngines.gameClockEngine.isRunning(gameId),
    "GameClock should be running after ENTRY_PAYMENT_COMPLETED"
);

assert(
    bootstrapEngines.physicsEngine.getSimulation(gameId)?.runtime?.state
        === "CREATED",
    "physics must stay CREATED during PRE_GAME_READY"
);

assert(
    bootstrapEngines.configurationEngine.getConfiguration(gameId),
    "configuration should be committed after bootstrap prep"
);

events.cleanup();

shutdownGameplayBootstrap(bootstrapEngines);

gameManager.shutdown();

playerManager.shutdown();

roomManager.shutdown();

eventBus.shutdown();

logger.shutdown();

console.log("gameplayBootstrap.integration.test.js: all assertions passed");
