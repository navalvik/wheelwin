import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { GAME_STATES } from "../engines/gameState/GameStates.js";
import { DEFAULT_PHYSICS_PARAMETERS } from "../engines/physics/PhysicsParameters.js";
import { GameManager } from "../managers/GameManager.js";
import { PlayerManager } from "../managers/PlayerManager.js";
import { RoomManager } from "../managers/RoomManager.js";
import { LoggerService } from "../services/LoggerService.js";
import {
    emitEntryPaymentCompleted,
    shutdownGameplayBootstrap,
    wireGameplayBootstrap
} from "./helpers/gameplayBootstrapHarness.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

function wait(ms) {

    return new Promise((resolve) => setTimeout(resolve, ms));

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

assert(
    bootstrapEngines.simulationLoop.isRunning(),
    "simulation loop should start"
);

const physicsUpdates = [];

eventBus.subscribe(EVENT_TYPES.PHYSICS_UPDATED, (envelope) => {

    physicsUpdates.push(envelope.payload);

});

let updateCallCount = 0;

const originalUpdate = bootstrapEngines.physicsEngine
    .updateSimulation.bind(bootstrapEngines.physicsEngine);

bootstrapEngines.physicsEngine.updateSimulation = (gameId, deltaTime) => {

    updateCallCount += 1;

    assert(
        deltaTime === DEFAULT_PHYSICS_PARAMETERS.fixedSimulationStepMs,
        "simulation loop should pass fixed deterministic deltaTime"
    );

    return originalUpdate(gameId, deltaTime);

};

const room = roomManager.createRoom();

const playerIds = ["player-1", "player-2", "player-3"];

for (const playerId of playerIds) {

    playerManager.createPlayer({ playerId });

    roomManager.addPlayer(room.roomId, playerId);

}

emitEntryPaymentCompleted(eventBus, room.roomId);

const games = gameManager.getGames();

assert(games.length === 1, "bootstrap should create exactly one game");

const gameId = games[0].gameId;

assert(
    bootstrapEngines.simulationLoop.getActiveGameCount() === 1,
    "simulation loop should track the active running simulation"
);

await wait(60);

assert(
    updateCallCount >= 3,
    "updateSimulation() should be called repeatedly by the simulation loop"
);

assert(
    physicsUpdates.length >= 3,
    "PHYSICS_UPDATED should be emitted repeatedly"
);

assert(
    bootstrapEngines.gameStateEngine.getState(gameId) !== null,
    "authoritative GameState should exist while simulation loop runs"
);

const simulation = bootstrapEngines.physicsEngine.getSimulation(gameId);

assert(simulation, "physics simulation should exist");

assert(
    simulation.runtime.angularVelocity === 0,
    "wheel velocity should remain zero"
);

assert(
    simulation.runtime.angle === 0,
    "wheel angle should remain unchanged with zero velocity"
);

const uniqueGameIds = new Set(physicsUpdates.map((payload) => payload.gameId));

assert(
    uniqueGameIds.size === 1 && uniqueGameIds.has(gameId),
    "physics updates should only target the active game"
);

bootstrapEngines.simulationLoop.shutdown();

shutdownGameplayBootstrap(bootstrapEngines);

gameManager.shutdown();

playerManager.shutdown();

roomManager.shutdown();

eventBus.shutdown();

logger.shutdown();

console.log("gameplaySimulationLoop.integration.test.js: all assertions passed");
