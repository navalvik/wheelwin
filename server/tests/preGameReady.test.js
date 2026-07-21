import assert from "node:assert/strict";

import { EventBus } from "../events/EventBus.js";
import { LoggerService } from "../services/LoggerService.js";
import { GameCatalog } from "../catalog/GameCatalog.js";
import { ConfigurationEngine } from "../engines/ConfigurationEngine.js";
import { GameClockEngine } from "../engines/GameClockEngine.js";
import { GameStateEngine } from "../engines/GameStateEngine.js";
import { PhysicsEngine } from "../engines/PhysicsEngine.js";
import { RandomService } from "../services/RandomService.js";
import { PreGameReadyActivation } from "../gameplay/PreGameReadyActivation.js";
import { ReadyPhaseBroadcaster } from "../gameplay/ReadyPhaseBroadcaster.js";
import { GameplayPhaseLifecycle } from "../gameplay/GameplayPhaseLifecycle.js";
import { GAME_STATES } from "../engines/gameState/GameStates.js";
import { PHYSICS_SIMULATION_STATE } from "../engines/physics/PhysicsSimulationState.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { TIMER_PHASES } from "../catalog/Timers.js";
import {
    createFastTimers,
    createFastInputCatalog
} from "./helpers/gameplayBootstrapHarness.js";

const logger = new LoggerService({ logLevel: "error" });

logger.initialize();

function createStack() {

    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    const catalog = new GameCatalog({ logger });

    catalog.initialize();

    catalog.getTimers = () => createFastTimers();

    const randomService = new RandomService({ logger });

    randomService.initialize();

    const gameStateEngine = new GameStateEngine({ logger, eventBus });

    const gameClockEngine = new GameClockEngine({
        logger,
        eventBus,
        gameCatalog: catalog
    });

    const configurationEngine = new ConfigurationEngine({
        logger,
        eventBus,
        gameCatalog: catalog,
        randomService
    });

    const physicsEngine = new PhysicsEngine({
        logger,
        eventBus,
        gameClock: gameClockEngine
    });

    gameStateEngine.initialize();

    gameClockEngine.initialize();

    configurationEngine.initialize();

    physicsEngine.initialize();

    const gameplayPhaseLifecycle = new GameplayPhaseLifecycle({
        logger,
        eventBus,
        gameStateEngine,
        gameClockEngine,
        devMode: true
    });

    gameplayPhaseLifecycle.initialize();

    const readyPhaseBroadcaster = new ReadyPhaseBroadcaster({
        logger,
        eventBus,
        configurationEngine,
        physicsEngine,
        devMode: true
    });

    readyPhaseBroadcaster.initialize();

    const preGameReadyActivation = new PreGameReadyActivation({
        logger,
        eventBus,
        configurationEngine,
        gameStateEngine,
        gameClockEngine,
        physicsEngine,
        devMode: true
    });

    preGameReadyActivation.initialize();

    return {
        eventBus,
        catalog,
        randomService,
        gameStateEngine,
        gameClockEngine,
        configurationEngine,
        physicsEngine,
        gameplayPhaseLifecycle,
        readyPhaseBroadcaster,
        preGameReadyActivation
    };

}

function shutdownStack(stack) {

    stack.preGameReadyActivation.shutdown();

    stack.readyPhaseBroadcaster.shutdown();

    stack.gameplayPhaseLifecycle.shutdown();

    stack.physicsEngine.shutdown();

    stack.gameClockEngine.shutdown();

    stack.gameStateEngine.shutdown();

    stack.configurationEngine.shutdown();

    stack.randomService.shutdown();

    stack.eventBus.shutdown();

}

function prepareGame(stack, gameId, playerIds) {

    let configuration = stack.configurationEngine.buildConfiguration(
        gameId,
        { roomId: `room-${gameId}`, stake: 1 },
        playerIds.map((playerId) => ({ playerId, sectorCount: 2 }))
    );

    stack.configurationEngine.validateConfiguration(configuration);

    configuration = stack.configurationEngine.freezeConfiguration(configuration);

    stack.configurationEngine.commitConfiguration(configuration);

    stack.gameStateEngine.initializeGameState(gameId);

    stack.physicsEngine.createSimulation(gameId);

    stack.gameClockEngine.createClock(gameId);

    stack.gameClockEngine.startClock(gameId);

}

function waitForReadyStarted(eventBus, gameId, timeoutMs = 500) {

    return new Promise((resolve, reject) => {

        const timer = setTimeout(() => {

            eventBus.unsubscribe(EVENT_TYPES.READY_STARTED, handler);

            reject(new Error(`READY_STARTED timeout for ${gameId}`));

        }, timeoutMs);

        const handler = (envelope) => {

            if (envelope.payload?.gameId !== gameId) {

                return;

            }

            clearTimeout(timer);

            eventBus.unsubscribe(EVENT_TYPES.READY_STARTED, handler);

            resolve(envelope.payload);

        };

        eventBus.subscribe(EVENT_TYPES.READY_STARTED, handler);

    });

}

// --- Scenario D: three confirmations → immediate READY ---

const stackA = createStack();

const gameIdA = "game-pre-game-ready-all-confirm";

const playerIds = ["player-1", "player-2", "player-3"];

const emittedA = [];

stackA.eventBus.subscribe(EVENT_TYPES.PRE_GAME_READY_STARTED, (envelope) => {

    emittedA.push({ type: envelope.type, payload: envelope.payload });

});

stackA.eventBus.subscribe(EVENT_TYPES.PRE_GAME_READY_UPDATED, (envelope) => {

    emittedA.push({ type: envelope.type, payload: envelope.payload });

});

stackA.eventBus.subscribe(EVENT_TYPES.PRE_GAME_READY_COMPLETED, (envelope) => {

    emittedA.push({ type: envelope.type, payload: envelope.payload });

});

prepareGame(stackA, gameIdA, playerIds);

assert.equal(
    stackA.gameStateEngine.getState(gameIdA),
    GAME_STATES.PRE_GAME_READY,
    "initial game state must be PRE_GAME_READY"
);

assert.equal(
    stackA.gameClockEngine.getClock(gameIdA).currentPhase,
    TIMER_PHASES.PRE_GAME_READY,
    "clock must start in PRE_GAME_READY"
);

assert.equal(
    stackA.physicsEngine.getSimulation(gameIdA).runtime.state,
    PHYSICS_SIMULATION_STATE.CREATED,
    "physics must stay CREATED during PRE_GAME_READY"
);

assert.ok(
    emittedA.some((entry) => entry.type === EVENT_TYPES.PRE_GAME_READY_STARTED),
    "PRE_GAME_READY_STARTED must be emitted"
);

const startedPayload = emittedA.find(
    (entry) => entry.type === EVENT_TYPES.PRE_GAME_READY_STARTED
).payload;

assert.equal(
    Object.keys(startedPayload.readyPlayers).length,
    3,
    "all players must be tracked"
);

for (const playerId of playerIds) {

    assert.equal(
        startedPayload.readyPlayers[playerId],
        false,
        `${playerId} must start unconfirmed`
    );

}

const snapshotBefore = stackA.preGameReadyActivation.getSnapshot(gameIdA);

assert.ok(snapshotBefore?.startedAt, "recovery snapshot must include startedAt");

assert.ok(snapshotBefore?.expiresAt, "recovery snapshot must include expiresAt");

assert.equal(
    snapshotBefore.expiresAt,
    startedPayload.expiresAt,
    "expiresAt must not restart on snapshot read"
);

for (const playerId of playerIds) {

    const result = stackA.preGameReadyActivation.handlePlayerReadyConfirm(
        gameIdA,
        playerId
    );

    assert.equal(result.accepted, true, `${playerId} confirmation must be accepted`);

}

const duplicate = stackA.preGameReadyActivation.handlePlayerReadyConfirm(
    gameIdA,
    playerIds[0]
);

assert.equal(
    duplicate.accepted,
    false,
    "repeated confirmation must be rejected"
);

assert.equal(
    stackA.gameClockEngine.getClock(gameIdA).currentPhase,
    TIMER_PHASES.READY,
    "all confirmations must advance clock to READY immediately"
);

assert.equal(
    stackA.gameStateEngine.getState(gameIdA),
    GAME_STATES.READY,
    "game state must transition to READY after all confirmations"
);

assert.equal(
    stackA.physicsEngine.getSimulation(gameIdA).runtime.state,
    PHYSICS_SIMULATION_STATE.RUNNING,
    "physics must start only when READY begins"
);

assert.ok(
    emittedA.some((entry) => entry.type === EVENT_TYPES.PRE_GAME_READY_COMPLETED),
    "PRE_GAME_READY_COMPLETED must be emitted on early complete"
);

shutdownStack(stackA);

// --- Scenario A: 0 confirmations → timeout → READY ---

const stackB = createStack();

const gameIdB = "game-pre-game-ready-timeout";

prepareGame(stackB, gameIdB, playerIds);

assert.equal(
    stackB.physicsEngine.getSimulation(gameIdB).runtime.state,
    PHYSICS_SIMULATION_STATE.CREATED,
    "physics must remain CREATED with zero confirmations"
);

await waitForReadyStarted(stackB.eventBus, gameIdB);

assert.equal(
    stackB.gameClockEngine.getClock(gameIdB).currentPhase,
    TIMER_PHASES.READY,
    "timeout must advance clock to READY with zero confirmations"
);

assert.equal(
    stackB.gameStateEngine.getState(gameIdB),
    GAME_STATES.READY,
    "timeout must transition game state to READY"
);

assert.equal(
    stackB.physicsEngine.getSimulation(gameIdB).runtime.state,
    PHYSICS_SIMULATION_STATE.RUNNING,
    "timeout path must start physics when READY begins"
);

const lateConfirm = stackB.preGameReadyActivation.handlePlayerReadyConfirm(
    gameIdB,
    playerIds[0]
);

assert.equal(
    lateConfirm.accepted,
    false,
    "confirmations after PRE_GAME_READY must be rejected"
);

shutdownStack(stackB);

// Silence unused import (harness helper kept for catalog parity).
void createFastInputCatalog;

console.log("preGameReady.test.js passed");
