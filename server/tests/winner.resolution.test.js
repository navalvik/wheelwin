import { GameCatalog } from "../catalog/GameCatalog.js";
import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { ConfigurationEngine } from "../engines/ConfigurationEngine.js";
import { PhysicsEngine } from "../engines/PhysicsEngine.js";
import { WinnerEngine } from "../engines/WinnerEngine.js";
import { WinnerActivation } from "../gameplay/WinnerActivation.js";
import { GameStateEngine } from "../engines/GameStateEngine.js";
import { LoggerService } from "../services/LoggerService.js";
import { RandomService } from "../services/RandomService.js";
import { createStandardConfigurationPlayers } from "./helpers/configurationPlayers.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

const logger = new LoggerService();

logger.initialize();

const catalog = new GameCatalog({ logger });

catalog.initialize();

const eventBus = new EventBus({
    logger,
    eventBusConfig: { logEvents: false, showDebugPanel: false }
});

eventBus.initialize();

const randomService = new RandomService({ logger });

randomService.initialize();

randomService.setSeed(7);

const configurationEngine = new ConfigurationEngine({
    logger,
    eventBus,
    gameCatalog: catalog,
    randomService
});

configurationEngine.initialize();

const physicsEngine = new PhysicsEngine({
    logger,
    eventBus,
    gameClock: null
});

physicsEngine.initialize();

const gameStateEngine = new GameStateEngine({ logger, eventBus });

gameStateEngine.initialize();

const winnerEngine = new WinnerEngine({
    logger,
    eventBus,
    physicsEngine,
    configurationEngine,
    gameCatalog: catalog
});

winnerEngine.initialize();

const winnerActivation = new WinnerActivation({
    logger,
    eventBus,
    physicsEngine,
    winnerEngine,
    gameStateEngine,
    devMode: false
});

winnerActivation.initialize();

const gameId = "winner-p58";

configurationEngine.generateConfiguration(
    gameId,
    { roomId: "room-p58", stake: 1 },
    createStandardConfigurationPlayers([
        "player-a",
        "player-b",
        "player-c"
    ])
);

physicsEngine.createSimulation(gameId);

physicsEngine.startSimulation(gameId);

physicsEngine.setPoseDegrees(gameId, 90, 15);

const determined = [];

eventBus.subscribe(EVENT_TYPES.WINNER_DETERMINED, (envelope) => {

    determined.push(envelope.payload);

});

// PHYSICS_STOPPED (from stopSimulation) → WinnerActivation → WinnerEngine
physicsEngine.stopSimulation(gameId);

assert(
    determined.length === 1,
    `WINNER_DETERMINED emitted once (got ${determined.length})`
);

const payload = determined[0];

assert(payload.winnerPlayerId, "winnerPlayerId present");

assert(
    Number.isFinite(payload.winnerSectorIndex),
    "winnerSectorIndex present"
);

assert(Number.isFinite(payload.wheelFinalAngle), "wheelFinalAngle present");

assert(
    Number.isFinite(payload.triangleFinalAngle),
    "triangleFinalAngle present"
);

assert(Number.isFinite(payload.resolvedAt), "resolvedAt present");

const stored = winnerEngine.getResult(gameId);

assert(Object.isFrozen(stored), "result immutable");

assert(
    stored.winnerPlayerId === payload.winnerPlayerId,
    "stored winner matches event"
);

// Same inputs → same winner
const again = winnerEngine.resolveResult(gameId);

assert(again === stored, "idempotent resolve returns stored result");

assert(
    again.winnerPlayerId === stored.winnerPlayerId,
    "same wheel angle always produces same winner"
);

// Repeated PHYSICS_STOPPED must not emit again
eventBus.emit({
    source: "PhysicsEngine",
    type: EVENT_TYPES.PHYSICS_STOPPED,
    payload: { gameId }
});

assert(determined.length === 1, "duplicate PHYSICS_STOPPED ignored");

console.log("winner.resolution.test.js passed");
