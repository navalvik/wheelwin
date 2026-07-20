import { TIMER_PHASES } from "../catalog/Timers.js";
import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { ConfigurationEngine } from "../engines/ConfigurationEngine.js";
import { GameClockEngine } from "../engines/GameClockEngine.js";
import { GameStateEngine } from "../engines/GameStateEngine.js";
import { PhysicsEngine } from "../engines/PhysicsEngine.js";
import { WinnerEngine } from "../engines/WinnerEngine.js";
import { GameCatalog } from "../catalog/GameCatalog.js";
import { GameplayPhaseLifecycle } from "../gameplay/GameplayPhaseLifecycle.js";
import { ResultActivation } from "../gameplay/ResultActivation.js";
import { LoggerService } from "../services/LoggerService.js";
import { RandomService } from "../services/RandomService.js";
import { GAME_STATES } from "../engines/gameState/GameStates.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

function createFastCatalog(base) {

    return {
        getTimers() {

            return {
                [TIMER_PHASES.READY]: { phase: TIMER_PHASES.READY, durationMs: 20 },
                [TIMER_PHASES.SELF_TEST]: { phase: TIMER_PHASES.SELF_TEST, durationMs: 20 },
                [TIMER_PHASES.SPEED]: { phase: TIMER_PHASES.SPEED, durationMs: 20 },
                [TIMER_PHASES.BRAKE]: { phase: TIMER_PHASES.BRAKE, durationMs: 20 },
                [TIMER_PHASES.RESULT]: { phase: TIMER_PHASES.RESULT, durationMs: 40 }
            };

        },
        getColors: () => base.getColors(),
        getIcons: () => base.getIcons(),
        getStakes: () => base.getStakes(),
        getWheelRules: () => base.getWheelRules(),
        getWinnerRules: () => base.getWinnerRules(),
        getInputRules: () => base.getInputRules()
    };

}

const logger = new LoggerService({ logLevel: "error" });

logger.initialize();

const eventBus = new EventBus({
    logger,
    eventBusConfig: { logEvents: false, showDebugPanel: false }
});

eventBus.initialize();

const catalog = new GameCatalog({ logger });

catalog.initialize();

const fastCatalog = createFastCatalog(catalog);

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

const gameStateEngine = new GameStateEngine({ logger, eventBus });

gameStateEngine.initialize();

const gameClockEngine = new GameClockEngine({
    logger,
    eventBus,
    gameCatalog: fastCatalog
});

gameClockEngine.initialize();

const winnerEngine = new WinnerEngine({
    logger,
    eventBus,
    physicsEngine,
    configurationEngine,
    gameCatalog: catalog
});

winnerEngine.initialize();

const phaseLifecycle = new GameplayPhaseLifecycle({
    logger,
    eventBus,
    gameStateEngine,
    gameClockEngine,
    winnerEngine,
    devMode: false
});

phaseLifecycle.initialize();

const resultActivation = new ResultActivation({
    logger,
    eventBus,
    gameClockEngine,
    winnerEngine,
    devMode: false
});

resultActivation.initialize();

const gameId = "result-p59";

const resultStarted = [];

const openPage6 = [];

eventBus.subscribe(EVENT_TYPES.RESULT_STARTED, (envelope) => {

    if (envelope.payload?.gameId === gameId) {

        resultStarted.push(envelope.payload);

    }

});

eventBus.subscribe(EVENT_TYPES.OPEN_PAGE6, (envelope) => {

    if (envelope.payload?.gameId === gameId) {

        openPage6.push(envelope.payload);

    }

});

configurationEngine.generateConfiguration(
    gameId,
    { roomId: "room-p59", stake: 1 },
    [
        { playerId: "player-a", sectorCount: 2 },
        { playerId: "player-b", sectorCount: 2 },
        { playerId: "player-c", sectorCount: 2 }
    ]
);

gameStateEngine.initializeGameState(gameId);

for (const state of [
    GAME_STATES.SELF_TEST,
    GAME_STATES.SPEED,
    GAME_STATES.BRAKE
]) {

    assert(
        gameStateEngine.transition(gameId, state, { reason: "test" }),
        `transition to ${state}`
    );

}

physicsEngine.createSimulation(gameId);

physicsEngine.startSimulation(gameId);

physicsEngine.setPoseDegrees(gameId, 90, 15);

physicsEngine.stopSimulation(gameId);

const result = winnerEngine.resolveResult(gameId);

assert(result?.winnerPlayerId, "winner must be resolved before RESULT");

gameClockEngine.createClock(gameId);

gameClockEngine.startClock(gameId);

gameClockEngine.restorePhaseSchedule(gameId, {
    phase: GAME_STATES.BRAKE,
    phaseStartedAt: Date.now() - 1000,
    phaseEndsAt: Date.now() + 5000
});

assert(resultStarted.length === 0, "RESULT must not auto-start from clock alone");

eventBus.emit({
    source: "WinnerEngine",
    type: EVENT_TYPES.WINNER_DETERMINED,
    payload: {
        gameId,
        winnerPlayerId: result.winnerPlayerId,
        winnerSectorIndex: result.winnerSectorIndex
    }
});

assert(resultStarted.length === 1, "RESULT_STARTED exactly once via ResultActivation");

assert(
    gameStateEngine.getState(gameId) === GAME_STATES.RESULT,
    "GameState must be RESULT after RESULT_STARTED"
);

assert(
    Number.isFinite(resultStarted[0].durationMs)
        && resultStarted[0].durationMs === 40,
    "RESULT duration must come from GameClock catalog"
);

assert(openPage6.length === 0, "OPEN_PAGE6 must wait for RESULT duration");

await new Promise((resolve) => {

    setTimeout(resolve, 80);

});

assert(openPage6.length === 1, "OPEN_PAGE6 after RESULT duration");

assert(
    resultActivation.hasOpenedPage6(gameId),
    "ResultActivation tracks OPEN_PAGE6 for recovery"
);

eventBus.emit({
    source: "WinnerEngine",
    type: EVENT_TYPES.WINNER_DETERMINED,
    payload: { gameId }
});

assert(resultStarted.length === 1, "RESULT_STARTED remains once");

assert(openPage6.length === 1, "OPEN_PAGE6 remains once");

resultActivation.shutdown();

phaseLifecycle.shutdown();

winnerEngine.shutdown();

gameClockEngine.shutdown();

gameStateEngine.shutdown();

physicsEngine.shutdown();

configurationEngine.shutdown();

randomService.shutdown();

eventBus.shutdown();

console.log("result.phase.test.js passed");
