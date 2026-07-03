import { TIMER_PHASES } from "../catalog/Timers.js";
import { INPUT_RULES } from "../catalog/InputRules.js";
import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { GAME_STATES } from "../engines/gameState/GameStates.js";
import { GameClockEngine } from "../engines/GameClockEngine.js";
import { GameStateEngine } from "../engines/GameStateEngine.js";
import { PhysicsEngine } from "../engines/PhysicsEngine.js";
import { InputAuthority } from "../input/InputAuthority.js";
import { PLAYER_STATE } from "../models/PlayerState.js";
import { GameManager } from "../managers/GameManager.js";
import { PlayerManager } from "../managers/PlayerManager.js";
import { RoomManager } from "../managers/RoomManager.js";
import { GameStateActivation } from "../gameplay/GameStateActivation.js";
import { SpeedActivation } from "../gameplay/SpeedActivation.js";
import { GameClockBroadcaster } from "../gameplay/GameClockBroadcaster.js";
import { LoggerService } from "../services/LoggerService.js";
import {
    createFastInputCatalog,
    createFastTimers,
    exhaustAllPlayerInput
} from "./helpers/gameplayBootstrapHarness.js";
import { GameCatalog } from "../catalog/GameCatalog.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

function wait(ms) {

    return new Promise((resolve) => setTimeout(resolve, ms));

}

async function poll(predicate, { timeoutMs = 3000, intervalMs = 5 } = {}) {

    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {

        if (predicate()) {

            return true;

        }

        await wait(intervalMs);

    }

    return false;

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

catalog.getTimers = () => createFastTimers();

const gameStateEngine = new GameStateEngine({ logger, eventBus });

const gameClockEngine = new GameClockEngine({
    logger,
    eventBus,
    gameCatalog: catalog
});

const physicsEngine = new PhysicsEngine({
    logger,
    eventBus,
    gameClock: gameClockEngine
});

const playerManager = new PlayerManager({ logger, eventBus });

const inputAuthority = new InputAuthority({
    logger,
    eventBus,
    gameCatalog: createFastInputCatalog(catalog),
    playerManager,
    physicsEngine,
    gameStateEngine,
    devMode: true
});

gameStateEngine.initialize();

gameClockEngine.initialize();

physicsEngine.initialize();

playerManager.initialize();

inputAuthority.initialize();

const gameStateActivation = new GameStateActivation({
    logger,
    eventBus,
    gameStateEngine,
    gameClockEngine,
    devMode: true
});

gameStateActivation.initialize();

const speedActivation = new SpeedActivation({
    logger,
    eventBus,
    gameClockEngine,
    gameStateEngine,
    devMode: true
});

speedActivation.initialize();

const gameClockBroadcaster = new GameClockBroadcaster({
    logger,
    eventBus,
    gameClockEngine,
    intervalMs: 50,
    devMode: true
});

gameClockBroadcaster.initialize();

const gameId = "speed-lifetime-game";

const players = ["speed_p1", "speed_p2", "speed_p3"];

eventBus.emit({
    source: "test",
    type: EVENT_TYPES.GAME_CREATED,
    payload: {
        gameId,
        roomId: "speed-room",
        players
    }
});

gameStateEngine.initializeGameState(gameId);

gameClockEngine.createClock(gameId);

gameClockEngine.startClock(gameId);

physicsEngine.createSimulation(gameId);

physicsEngine.startSimulation(gameId);

for (const playerId of players) {

    playerManager.createPlayer({ playerId });

    playerManager.setPlayerState(playerId, PLAYER_STATE.PLAYING);

}

inputAuthority.registerPlayers(gameId, players);

const reachedSpeed = await poll(
    () => gameStateEngine.getState(gameId) === GAME_STATES.SPEED
);

assert(reachedSpeed, "game should reach SPEED via authoritative clock");

const speedEnteredAt = Date.now();

await wait(120);

assert(
    gameStateEngine.getState(gameId) === GAME_STATES.SPEED,
    "SPEED must persist without automatic transition (no setImmediate placeholder)"
);

assert(
    Date.now() - speedEnteredAt >= 100,
    "SPEED should remain active for a meaningful duration before gameplay completes"
);

const clockUpdates = [];

eventBus.subscribe(EVENT_TYPES.CLOCK_UPDATE, (envelope) => {

    if (envelope.payload?.gameId === gameId) {

        clockUpdates.push(envelope.payload);

    }

});

await wait(80);

const speedClockPackets = clockUpdates.filter(
    (packet) => packet.phase === TIMER_PHASES.SPEED
);

assert(
    speedClockPackets.length >= 1,
    "CLOCK_UPDATE should continue broadcasting during SPEED"
);

for (const packet of speedClockPackets) {

    assert(
        packet.remainingSeconds === null,
        "SPEED broadcasts must report remainingSeconds = null (no fake countdown)"
    );

}

let speedPhaseTimeouts = 0;

eventBus.subscribe(EVENT_TYPES.PHASE_TIMEOUT, (envelope) => {

    if (envelope.payload?.gameId === gameId
        && envelope.payload?.phase === GAME_STATES.SPEED) {

        speedPhaseTimeouts += 1;

    }

});

exhaustAllPlayerInput(inputAuthority, gameId, players);

const reachedBrake = await poll(
    () => gameStateEngine.getState(gameId) === GAME_STATES.BRAKE
);

assert(reachedBrake, "all players finishing input should complete SPEED -> BRAKE");

assert(
    speedPhaseTimeouts === 1,
    "GameClock.completePhase() must run exactly once for SPEED"
);

assert(
    gameClockEngine.getClock(gameId).currentPhase === TIMER_PHASES.BRAKE,
    "clock phase should advance to BRAKE after gameplay completion"
);

gameClockBroadcaster.shutdown();

speedActivation.shutdown();

gameStateActivation.shutdown();

inputAuthority.shutdown();

physicsEngine.shutdown();

gameClockEngine.shutdown();

gameStateEngine.shutdown();

playerManager.shutdown();

eventBus.shutdown();

logger.shutdown();

console.log("speedActivation.integration.test.js: all assertions passed");
