import { GameCatalog } from "../catalog/GameCatalog.js";
import { INPUT_RULES } from "../catalog/InputRules.js";
import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { GameStateEngine } from "../engines/GameStateEngine.js";
import { PhysicsEngine } from "../engines/PhysicsEngine.js";
import { GAME_STATES } from "../engines/gameState/GameStates.js";
import { InputAuthority } from "../input/InputAuthority.js";
import { PLAYER_STATE } from "../models/PlayerState.js";
import { PlayerManager } from "../managers/PlayerManager.js";
import { LoggerService } from "../services/LoggerService.js";
import { SimulationLoop } from "../simulation/SimulationLoop.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

function createFastCatalog() {

    const catalog = new GameCatalog({ logger: new LoggerService() });

    catalog.initialize();

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

function buildStack() {

    const logger = new LoggerService({ logLevel: "error" });

    logger.initialize();

    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    const playerManager = new PlayerManager({ logger, eventBus });

    playerManager.initialize();

    const physicsEngine = new PhysicsEngine({
        logger,
        eventBus,
        gameClock: null
    });

    physicsEngine.initialize();

    const gameStateEngine = new GameStateEngine({ logger, eventBus });

    gameStateEngine.initialize();

    const inputAuthority = new InputAuthority({
        logger,
        eventBus,
        gameCatalog: createFastCatalog(),
        playerManager,
        physicsEngine,
        gameStateEngine,
        devMode: false
    });

    inputAuthority.initialize();

    const simulationLoop = new SimulationLoop({
        logger,
        eventBus,
        physicsEngine,
        inputAuthority,
        devMode: false
    });

    simulationLoop.initialize();

    const callOrder = [];

    const originalApplyAcceleration = physicsEngine.applyAcceleration
        .bind(physicsEngine);

    physicsEngine.applyAcceleration = (gameId, value) => {

        callOrder.push({ type: "accelerate", gameId, value });

        return originalApplyAcceleration(gameId, value);

    };

    const originalUpdate = physicsEngine.updateSimulation
        .bind(physicsEngine);

    physicsEngine.updateSimulation = (gameId, deltaTime) => {

        callOrder.push({ type: "update", gameId, deltaTime });

        return originalUpdate(gameId, deltaTime);

    };

    const physicsUpdates = [];

    eventBus.subscribe(EVENT_TYPES.PHYSICS_UPDATED, (envelope) => {

        physicsUpdates.push(envelope.payload);

    });

    return {
        logger,
        eventBus,
        playerManager,
        physicsEngine,
        gameStateEngine,
        inputAuthority,
        simulationLoop,
        callOrder,
        physicsUpdates,
        shutdown() {

            simulationLoop.shutdown();

            inputAuthority.shutdown();

            physicsEngine.shutdown();

            gameStateEngine.shutdown();

            playerManager.shutdown();

            eventBus.shutdown();

            logger.shutdown();

        }
    };

}

function activateGame(stack, gameId, { targetState = GAME_STATES.SPEED } = {}) {

    const player = stack.playerManager.createPlayer({ nickname: "Racer" });

    const playerId = player.identity.playerId;

    stack.playerManager.setPlayerState(playerId, PLAYER_STATE.PLAYING);

    stack.gameStateEngine.initializeGameState(gameId);

    const path = [
        GAME_STATES.COUNTDOWN,
        GAME_STATES.SELF_TEST,
        GAME_STATES.SPEED,
        GAME_STATES.BRAKE,
        GAME_STATES.RESULT
    ];

    for (const state of path) {

        stack.gameStateEngine.transition(gameId, state, { reason: "test" });

        if (state === targetState) {

            break;

        }

    }

    stack.physicsEngine.createSimulation(gameId);

    stack.physicsEngine.startSimulation(gameId);

    stack.inputAuthority.registerPlayer(gameId, playerId);

    return { playerId };

}

// -------------------------------------------------------------------------
// Scenario 1: accepted input flows through the queue into deterministic physics
// -------------------------------------------------------------------------

{

    const stack = buildStack();

    try {

        const gameId = "physics-control-accept";

        const { playerId } = activateGame(stack, gameId);

        assert(
            stack.simulationLoop.getActiveGameCount() === 1,
            "simulation loop should track the running game"
        );

        // The SocketGateway calls handleButtonPress. This must ONLY enqueue —
        // physics must never be applied directly from the socket-driven path.
        const accepted = stack.inputAuthority.handleButtonPress(gameId, playerId);

        assert(accepted, "input during SPEED should be accepted");

        assert(
            stack.inputAuthority.getAcceptedCommands(gameId).length === 1,
            "accepted command should enter the queue"
        );

        assert(
            !stack.callOrder.some((entry) => entry.type === "accelerate"),
            "applyAcceleration must NOT be called directly from the input path"
        );

        const beforeTick = stack.physicsEngine.getSimulation(gameId);

        assert(
            beforeTick.runtime.angle === 0
                && beforeTick.runtime.angularVelocity === 0,
            "wheel must remain stationary until a simulation tick runs"
        );

        // One deterministic tick: process queue → apply acceleration → update.
        stack.simulationLoop._onTick();

        const accelIndex = stack.callOrder
            .findIndex((entry) => entry.type === "accelerate");

        const updateIndex = stack.callOrder
            .findIndex((entry) => entry.type === "update");

        assert(accelIndex >= 0, "queue tick should apply acceleration");

        assert(updateIndex >= 0, "queue tick should update physics");

        assert(
            accelIndex < updateIndex,
            "queue processing must happen BEFORE updateSimulation()"
        );

        assert(
            stack.callOrder[accelIndex].value === INPUT_RULES.accelerationRadPerSecSq,
            "acceleration value should come from input rules"
        );

        for (let tick = 0; tick < 20; tick += 1) {

            stack.simulationLoop._onTick();

        }

        const moving = stack.physicsEngine.getSimulation(gameId);

        assert(
            moving.runtime.angularVelocity > 0,
            "wheel should be rotating after accepted input"
        );

        assert(
            moving.runtime.angle > 0,
            "wheel angle should change after accepted input"
        );

        assert(
            stack.physicsUpdates.length >= 20,
            "PHYSICS_UPDATED should be emitted every tick"
        );

        const firstAngle = stack.physicsUpdates[0].angle;

        const lastAngle = stack.physicsUpdates[stack.physicsUpdates.length - 1].angle;

        assert(
            lastAngle !== firstAngle,
            "PHYSICS_UPDATED payloads should contain changing wheel angle"
        );

        // The queue must be empty again — commands are consumed once, on the tick.
        stack.inputAuthority.processCommandQueue(gameId);

        console.log("  scenario 1 (accepted input drives physics) passed");

    } finally {

        stack.shutdown();

    }

}

// -------------------------------------------------------------------------
// Scenario 2: rejected input never reaches physics
// -------------------------------------------------------------------------

{

    const stack = buildStack();

    try {

        const gameId = "physics-control-reject";

        const { playerId } = activateGame(stack, gameId, {
            targetState: GAME_STATES.COUNTDOWN
        });

        const rejected = stack.inputAuthority.handleButtonPress(gameId, playerId);

        assert(rejected === null, "input outside SPEED should be rejected");

        assert(
            stack.inputAuthority.getAcceptedCommands(gameId).length === 0,
            "rejected command must not enter the queue"
        );

        for (let tick = 0; tick < 20; tick += 1) {

            stack.simulationLoop._onTick();

        }

        assert(
            !stack.callOrder.some((entry) => entry.type === "accelerate"),
            "rejected input must never call applyAcceleration"
        );

        const simulation = stack.physicsEngine.getSimulation(gameId);

        assert(
            simulation.runtime.angle === 0
                && simulation.runtime.angularVelocity === 0,
            "wheel must remain stationary when input is rejected"
        );

        console.log("  scenario 2 (rejected input never moves wheel) passed");

    } finally {

        stack.shutdown();

    }

}

// -------------------------------------------------------------------------
// Scenario 3: physics is deterministic for identical command + tick sequences
// -------------------------------------------------------------------------

function runDeterministicSequence() {

    const stack = buildStack();

    try {

        const gameId = "physics-control-determinism";

        const { playerId } = activateGame(stack, gameId);

        stack.inputAuthority.handleButtonPress(gameId, playerId);

        for (let tick = 0; tick < 15; tick += 1) {

            stack.simulationLoop._onTick();

        }

        const simulation = stack.physicsEngine.getSimulation(gameId);

        return {
            angle: simulation.runtime.angle,
            angularVelocity: simulation.runtime.angularVelocity
        };

    } finally {

        stack.shutdown();

    }

}

{

    const runA = runDeterministicSequence();

    const runB = runDeterministicSequence();

    assert(
        runA.angle === runB.angle,
        "identical command + tick sequences must produce identical wheel angle"
    );

    assert(
        runA.angularVelocity === runB.angularVelocity,
        "identical command + tick sequences must produce identical velocity"
    );

    assert(runA.angle > 0, "deterministic run should actually move the wheel");

    console.log("  scenario 3 (deterministic physics) passed");

}

console.log("gameplayPhysicsControl.integration.test.js: all assertions passed");
