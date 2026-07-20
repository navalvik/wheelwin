import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { LoggerService } from "../services/LoggerService.js";
import { GameCatalog } from "../catalog/GameCatalog.js";
import { INPUT_RULES } from "../catalog/InputRules.js";
import { GameClockEngine } from "../engines/GameClockEngine.js";
import { GameStateEngine } from "../engines/GameStateEngine.js";
import { PhysicsEngine } from "../engines/PhysicsEngine.js";
import { InputAuthority } from "../input/InputAuthority.js";
import { PlayerManager } from "../managers/PlayerManager.js";
import { SimulationLoop } from "../simulation/SimulationLoop.js";
import { GAME_STATES } from "../engines/gameState/GameStates.js";
import { PLAYER_STATE } from "../models/PlayerState.js";
import { CONNECTION_STATE } from "../models/ConnectionState.js";
import { GameStateActivation } from "../gameplay/GameStateActivation.js";
import { GameplayTimerLifecycle } from "../gameplay/GameplayTimerLifecycle.js";
import { AutoFinishActivation } from "../gameplay/AutoFinishActivation.js";
import { createFastTimers } from "./helpers/gameplayBootstrapHarness.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

function wait(ms) {

    return new Promise((resolve) => setTimeout(resolve, ms));

}

async function poll(predicate, timeoutMs = 3_000, intervalMs = 20) {

    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {

        if (predicate()) {

            return true;

        }

        await wait(intervalMs);

    }

    return false;

}

function createFastInputCatalog(catalog) {

    return {
        getInputRules() {

            return {
                ...INPUT_RULES,
                pressCooldownMs: 0
            };

        },
        getColors: () => catalog.getColors(),
        getIcons: () => catalog.getIcons(),
        getStakes: () => catalog.getStakes(),
        getTimers: () => catalog.getTimers(),
        getWheelRules: () => catalog.getWheelRules()
    };

}

function bootstrapStack({
    gameId,
    roomId,
    playerIds,
    brakeLeadMs,
    spinGraceMs,
    gameplayDurationMs,
    gameplayWarningMs
}) {

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

    const fastInputCatalog = createFastInputCatalog(catalog);

    const playerManager = new PlayerManager({ logger, eventBus });

    playerManager.initialize();

    const gameStateEngine = new GameStateEngine({ logger, eventBus });

    gameStateEngine.initialize();

    const gameClockEngine = new GameClockEngine({
        logger,
        eventBus,
        gameCatalog: catalog
    });

    gameClockEngine.initialize();

    const physicsEngine = new PhysicsEngine({
        logger,
        eventBus,
        gameClock: gameClockEngine
    });

    physicsEngine.initialize();

    const inputAuthority = new InputAuthority({
        logger,
        eventBus,
        gameCatalog: fastInputCatalog,
        playerManager,
        physicsEngine,
        gameStateEngine,
        devMode: true
    });

    inputAuthority.initialize();

    const simulationLoop = new SimulationLoop({
        logger,
        eventBus,
        physicsEngine,
        inputAuthority,
        devMode: true
    });

    simulationLoop.initialize();

    const gameStateActivation = new GameStateActivation({
        logger,
        eventBus,
        gameStateEngine,
        gameClockEngine,
        devMode: true
    });

    gameStateActivation.initialize();

    const gameplayTimerLifecycle = new GameplayTimerLifecycle({
        logger,
        eventBus,
        gameplayTimerConfig: {
            gameplayDurationMs,
            gameplayWarningMs
        },
        devMode: true
    });

    gameplayTimerLifecycle.initialize();

    const autoFinish = new AutoFinishActivation({
        logger,
        eventBus,
        physicsEngine,
        inputAuthority,
        gameStateEngine,
        gameClockEngine,
        gameCatalog: fastInputCatalog,
        brakeLeadMs,
        spinGraceMs,
        devMode: true
    });

    autoFinish.initialize();

    for (const playerId of playerIds) {

        playerManager.createPlayer({ playerId });

        playerManager.setPlayerState(playerId, PLAYER_STATE.PLAYING);

        playerManager.setConnectionState(
            playerId,
            CONNECTION_STATE.CONNECTED
        );

    }

    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.GAME_CREATED,
        payload: { gameId, players: playerIds }
    });

    inputAuthority.registerPlayers(gameId, playerIds);

    physicsEngine.createSimulation(gameId);

    physicsEngine.startSimulation(gameId);

    gameStateEngine.initializeGameState(gameId);

    gameClockEngine.createClock(gameId);

    gameClockEngine.startClock(gameId);

    return {
        logger,
        eventBus,
        catalog,
        playerManager,
        gameStateEngine,
        gameClockEngine,
        physicsEngine,
        inputAuthority,
        simulationLoop,
        gameStateActivation,
        gameplayTimerLifecycle,
        autoFinish
    };

}

function shutdownStack(stack) {

    stack.autoFinish.shutdown();

    stack.gameplayTimerLifecycle.shutdown();

    stack.gameStateActivation.shutdown();

    stack.simulationLoop.stop();

    stack.simulationLoop.shutdown();

    stack.inputAuthority.shutdown();

    stack.physicsEngine.shutdown();

    stack.gameClockEngine.shutdown();

    stack.gameStateEngine.shutdown();

    stack.playerManager.shutdown();

    stack.eventBus.shutdown();

}

function tick(stack, times = 1) {

    for (let i = 0; i < times; i += 1) {

        stack.simulationLoop._onTick();

    }

}

async function startGameplayTimer(stack, gameId, roomId) {

    stack.eventBus.emit({
        source: "test",
        type: EVENT_TYPES.GAME_INITIALIZED,
        payload: { gameId, roomId }
    });

}

// -------------------------------------------------------------------------
// E2E — GAME_INITIALIZED → WARNING → AutoFinish → AUTO_FINISH_STARTED
// -------------------------------------------------------------------------

{

    const gameId = "e2e-auto-finish";

    const roomId = "room-e2e";

    const stack = bootstrapStack({
        gameId,
        roomId,
        playerIds: ["p1", "p2", "p3"],
        brakeLeadMs: 40,
        spinGraceMs: 20,
        gameplayDurationMs: 200,
        gameplayWarningMs: 80
    });

    const events = [];

    for (const type of [
        EVENT_TYPES.GAMEPLAY_TIMER_WARNING,
        EVENT_TYPES.AUTO_FINISH_STARTED
    ]) {

        stack.eventBus.subscribe(type, (envelope) => {

            events.push(envelope.type);

        });

    }

    assert(
        await poll(
            () => stack.gameStateEngine.getState(gameId) === GAME_STATES.SPEED
        ),
        "E2E reaches SPEED"
    );

    await startGameplayTimer(stack, gameId, roomId);

    assert(
        await poll(() => events.includes(EVENT_TYPES.GAMEPLAY_TIMER_WARNING)),
        "E2E: WARNING originates from GameplayTimerLifecycle"
    );

    assert(
        events.filter((t) => t === EVENT_TYPES.GAMEPLAY_TIMER_WARNING).length
            === 1,
        "E2E: WARNING exactly once"
    );

    assert(
        await poll(() => events.includes(EVENT_TYPES.AUTO_FINISH_STARTED)),
        "E2E: AUTO_FINISH_STARTED follows natural WARNING"
    );

    assert(
        events.filter((t) => t === EVENT_TYPES.AUTO_FINISH_STARTED).length
            === 1,
        "E2E: AUTO_FINISH_STARTED exactly once"
    );

    shutdownStack(stack);

    console.log("  E2E WARNING → AutoFinish passed");

}

// -------------------------------------------------------------------------
// Case 2 — ω == 0: natural WARNING → server agents → BRAKE
// -------------------------------------------------------------------------

{

    const gameId = "game-auto-finish-case2";

    const roomId = "room-case2";

    const stack = bootstrapStack({
        gameId,
        roomId,
        playerIds: ["p1", "p2", "p3"],
        brakeLeadMs: 40,
        spinGraceMs: 20,
        gameplayDurationMs: 250,
        gameplayWarningMs: 80
    });

    assert(
        await poll(
            () => stack.gameStateEngine.getState(gameId) === GAME_STATES.SPEED
        ),
        "Case 2 reaches SPEED via authoritative clock"
    );

    assert(
        stack.physicsEngine.getSimulation(gameId).runtime.angularVelocity === 0,
        "Case 2 starts with ω == 0"
    );

    const autoFinishEvents = [];

    stack.eventBus.subscribe(EVENT_TYPES.AUTO_FINISH_STARTED, () => {

        autoFinishEvents.push(1);

    });

    await startGameplayTimer(stack, gameId, roomId);

    assert(
        await poll(() => autoFinishEvents.length === 1),
        "Case 2: AUTO_FINISH_STARTED from natural WARNING"
    );

    for (let i = 0; i < 80; i += 1) {

        tick(stack, 1);

        if (stack.physicsEngine.getSimulation(gameId).runtime.angularVelocity
            > 0) {

            break;

        }

    }

    assert(
        stack.physicsEngine.getSimulation(gameId).runtime.angularVelocity > 0,
        "Case 2 Auto Finish starts the wheel via InputAuthority"
    );

    assert(
        await poll(
            () => {
                const state = stack.gameStateEngine.getState(gameId);

                return state === GAME_STATES.BRAKE
                    || state === GAME_STATES.RESULT;

            },
            3_000
        ),
        "Case 2 schedules force BRAKE"
    );

    shutdownStack(stack);

    console.log("  AutoFinish Case 2 + natural WARNING passed");

}

// -------------------------------------------------------------------------
// Case 1 — ω > 0: natural WARNING → preserve ω → BRAKE
// -------------------------------------------------------------------------

{

    const gameId = "game-auto-finish-case1";

    const roomId = "room-case1";

    const stack = bootstrapStack({
        gameId,
        roomId,
        playerIds: ["a"],
        brakeLeadMs: 30,
        spinGraceMs: 10,
        gameplayDurationMs: 250,
        gameplayWarningMs: 80
    });

    assert(
        await poll(
            () => stack.gameStateEngine.getState(gameId) === GAME_STATES.SPEED
        ),
        "Case 1 reaches SPEED via authoritative clock"
    );

    const pressed = stack.inputAuthority.handleButtonPress(gameId, "a");

    assert(pressed, "Case 1 prep press accepted");

    tick(stack, 25);

    stack.inputAuthority.handleButtonRelease(gameId, "a");

    tick(stack, 5);

    assert(
        stack.physicsEngine.getSimulation(gameId).runtime.angularVelocity > 0,
        "Case 1 starts with ω > 0"
    );

    const omegaBefore = stack.physicsEngine
        .getSimulation(gameId).runtime.angularVelocity;

    await startGameplayTimer(stack, gameId, roomId);

    assert(
        await poll(
            () => stack.gameplayTimerLifecycle.getTimer(gameId)?.warningEmitted
                === true
        ),
        "Case 1: natural WARNING emitted"
    );

    assert(
        stack.physicsEngine.getSimulation(gameId).runtime.angularVelocity
            >= omegaBefore * 0.5,
        "Case 1 does not reset / teleport wheel"
    );

    assert(
        await poll(
            () => {
                const state = stack.gameStateEngine.getState(gameId);

                return state === GAME_STATES.BRAKE
                    || state === GAME_STATES.RESULT;

            },
            3_000
        ),
        "Case 1 schedules force BRAKE"
    );

    shutdownStack(stack);

    console.log("  AutoFinish Case 1 + natural WARNING passed");

}

console.log("autoFinish.activation.test.js: all assertions passed");
