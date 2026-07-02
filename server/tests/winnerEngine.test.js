import { GameCatalog } from "../catalog/GameCatalog.js";
import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { ConfigurationEngine } from "../engines/ConfigurationEngine.js";
import { GeometryAdapter } from "../engines/winner/GeometryAdapter.js";
import { PhysicsEngine } from "../engines/PhysicsEngine.js";
import { PHYSICS_SIMULATION_STATE } from "../engines/physics/PhysicsSimulationState.js";
import { WinnerEngine } from "../engines/WinnerEngine.js";
import { LoggerService } from "../services/LoggerService.js";
import { RandomService } from "../services/RandomService.js";

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

randomService.setSeed(42);

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

const winnerEngine = new WinnerEngine({
    logger,
    eventBus,
    physicsEngine,
    configurationEngine,
    gameCatalog: catalog
});

winnerEngine.initialize();

const gameId = "winner-test-game";

const configuration = configurationEngine.generateConfiguration(
    gameId,
    { roomId: "room-winner", stake: 1 },
    [
        { playerId: "player-a", sectorCount: 2 },
        { playerId: "player-b", sectorCount: 2 },
        { playerId: "player-c", sectorCount: 2 }
    ]
);

physicsEngine.createSimulation(gameId);

physicsEngine.startSimulation(gameId);

physicsEngine.stopSimulation(gameId);

const geometryAdapter = new GeometryAdapter({
    angleToleranceRadians: catalog.getWinnerRules().angleToleranceRadians
});

const sectorIndex = geometryAdapter.resolveSectorIndex({
    finalWheelAngleRadians: 0,
    triangleAngleDegrees: configuration.triangle.startAngle,
    sectorCount: configuration.sectors.length
});

const expectedSector = configuration.sectors[sectorIndex];

const emitted = [];

eventBus.subscribe(EVENT_TYPES.GAME_RESULT_READY, (envelope) => {

    emitted.push(envelope.type);

});

const result = winnerEngine.resolveResult(gameId);

assert(result.winningSector.sectorId === expectedSector.sectorId, "sector should match geometry");

assert(
    result.winningPlayer.playerId === expectedSector.ownerId,
    "player should match sector owner"
);

assert(result.prize === null && result.payout === null, "prize fields should be null");

assert(Object.isFrozen(result), "result should be frozen");

const replay = winnerEngine.resolveWinningSector(gameId);

assert(
    replay.sectorId === result.winningSector.sectorId,
    "sector replay should match"
);

assert(emitted.length === 1, "GAME_RESULT_READY should be emitted once");

assert(
    physicsEngine.getSimulation(gameId).runtime.state
        === PHYSICS_SIMULATION_STATE.STOPPED,
    "physics state should remain unchanged"
);

winnerEngine.removeResult(gameId);

configurationEngine.removeConfiguration(gameId);

physicsEngine.removeSimulation(gameId);

winnerEngine.shutdown();

configurationEngine.shutdown();

physicsEngine.shutdown();

randomService.shutdown();

logger.info("WinnerEngine tests passed");
