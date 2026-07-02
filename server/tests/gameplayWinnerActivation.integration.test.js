import { GameCatalog } from "../catalog/GameCatalog.js";
import { INPUT_RULES } from "../catalog/InputRules.js";
import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { ConfigurationEngine } from "../engines/ConfigurationEngine.js";
import { GameStateEngine } from "../engines/GameStateEngine.js";
import { PhysicsEngine } from "../engines/PhysicsEngine.js";
import { WinnerEngine } from "../engines/WinnerEngine.js";
import { GAME_STATES } from "../engines/gameState/GameStates.js";
import { InputAuthority } from "../input/InputAuthority.js";
import { PLAYER_STATE } from "../models/PlayerState.js";
import { PlayerManager } from "../managers/PlayerManager.js";
import { LoggerService } from "../services/LoggerService.js";
import { RandomService } from "../services/RandomService.js";
import { SimulationLoop } from "../simulation/SimulationLoop.js";
import { WinnerActivation } from "../gameplay/WinnerActivation.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

function createFastCatalog(catalog) {

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
        getWheelRules: () => catalog.getWheelRules(),
        getWinnerRules: () => catalog.getWinnerRules()
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

    const catalog = new GameCatalog({ logger });

    catalog.initialize();

    const randomService = new RandomService({ logger });

    randomService.initialize();

    randomService.setSeed(1234);

    const playerManager = new PlayerManager({ logger, eventBus });

    playerManager.initialize();

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

    const inputAuthority = new InputAuthority({
        logger,
        eventBus,
        gameCatalog: createFastCatalog(catalog),
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

    const winnerActivation = new WinnerActivation({
        logger,
        eventBus,
        physicsEngine,
        winnerEngine,
        gameStateEngine,
        devMode: false
    });

    winnerActivation.initialize();

    return {
        logger,
        eventBus,
        catalog,
        randomService,
        playerManager,
        configurationEngine,
        physicsEngine,
        gameStateEngine,
        winnerEngine,
        inputAuthority,
        simulationLoop,
        winnerActivation,
        shutdown() {

            winnerActivation.shutdown();

            simulationLoop.shutdown();

            inputAuthority.shutdown();

            winnerEngine.shutdown();

            gameStateEngine.shutdown();

            physicsEngine.shutdown();

            configurationEngine.shutdown();

            playerManager.shutdown();

            randomService.shutdown();

            eventBus.shutdown();

            logger.shutdown();

        }
    };

}

function activateGame(stack, gameId) {

    const players = [];

    for (let index = 0; index < 3; index += 1) {

        const player = stack.playerManager.createPlayer({
            nickname: `Racer ${index + 1}`
        });

        stack.playerManager.setPlayerState(
            player.identity.playerId,
            PLAYER_STATE.PLAYING
        );

        players.push(player.identity.playerId);

    }

    let configuration = stack.configurationEngine.buildConfiguration(
        gameId,
        { roomId: "winner-room", stake: 10 },
        players.map((playerId) => ({ playerId, sectorCount: 2 }))
    );

    stack.configurationEngine.validateConfiguration(configuration);

    configuration = stack.configurationEngine.freezeConfiguration(configuration);

    stack.configurationEngine.commitConfiguration(configuration);

    stack.gameStateEngine.initializeGameState(gameId);

    for (const state of [
        GAME_STATES.COUNTDOWN,
        GAME_STATES.SELF_TEST,
        GAME_STATES.SPEED
    ]) {

        stack.gameStateEngine.transition(gameId, state, { reason: "test" });

    }

    stack.physicsEngine.createSimulation(gameId);

    stack.physicsEngine.startSimulation(gameId);

    stack.inputAuthority.registerPlayers(gameId, players);

    return { players };

}

// -------------------------------------------------------------------------
// Scenario 1: winner is determined exactly once, after the wheel stops,
// RESULT follows, and the final angle is immutable.
// -------------------------------------------------------------------------

{

    const stack = buildStack();

    try {

        const gameId = "winner-activation-happy";

        const { players } = activateGame(stack, gameId);

        let winnerDeterminedCount = 0;

        let winnerPayload = null;

        let physicsStateAtWinner = null;

        let resultHadWinner = null;

        stack.eventBus.subscribe(EVENT_TYPES.WINNER_DETERMINED, (envelope) => {

            winnerDeterminedCount += 1;

            winnerPayload = envelope.payload;

            physicsStateAtWinner = stack.physicsEngine
                .getSimulation(gameId).runtime.state;

        });

        stack.eventBus.subscribe(EVENT_TYPES.GAME_STATE_CHANGED, (envelope) => {

            if (envelope.payload?.currentState === GAME_STATES.RESULT) {

                resultHadWinner = Boolean(stack.winnerEngine.getResult(gameId));

            }

        });

        // Drive gameplay input so the wheel is genuinely rotating.
        for (const playerId of players) {

            stack.inputAuthority.handleButtonPress(gameId, playerId);

        }

        // Run enough ticks for the wheel to spin up while in SPEED.
        for (let tick = 0; tick < 10; tick += 1) {

            stack.simulationLoop._onTick();

        }

        const spinning = stack.physicsEngine.getSimulation(gameId);

        assert(
            spinning.runtime.angularVelocity > 0,
            "wheel should be rotating during SPEED"
        );

        assert(
            winnerDeterminedCount === 0,
            "winner must NOT be determined while the wheel is moving"
        );

        // Enter BRAKE: WinnerActivation applies the authoritative brake.
        stack.gameStateEngine.transition(gameId, GAME_STATES.BRAKE, {
            reason: "test"
        });

        // Run ticks until the wheel stops and the winner resolves.
        let guard = 0;

        while (
            stack.gameStateEngine.getState(gameId) !== GAME_STATES.RESULT
            && guard < 1000
        ) {

            stack.simulationLoop._onTick();

            guard += 1;

        }

        assert(guard < 1000, "wheel should reach a stopping condition");

        const stopped = stack.physicsEngine.getSimulation(gameId);

        assert(
            stopped.runtime.state === "STOPPED",
            "physics simulation should be STOPPED before winner determination"
        );

        assert(
            winnerDeterminedCount === 1,
            "WINNER_DETERMINED must be emitted exactly once"
        );

        assert(
            physicsStateAtWinner === "STOPPED",
            "winner must be determined only after the wheel has stopped"
        );

        assert(
            resultHadWinner === true,
            "RESULT must follow winner determination (winner available at RESULT)"
        );

        assert(
            stack.gameStateEngine.getState(gameId) === GAME_STATES.RESULT,
            "GameState should reach RESULT after winner determination"
        );

        // Authoritative winner payload shape (no internal physics state).
        assert(winnerPayload.gameId === gameId, "winner payload should include gameId");

        assert(
            typeof winnerPayload.winningPlayerId === "string",
            "winner payload should include winningPlayerId"
        );

        assert(
            players.includes(winnerPayload.winningPlayerId),
            "winning player must be one of the registered players"
        );

        assert(
            winnerPayload.winningSector
                && typeof winnerPayload.winningSector.sectorId === "string",
            "winner payload should include winning sector"
        );

        assert(
            Number.isFinite(winnerPayload.finalWheelAngle),
            "winner payload should include finalWheelAngle"
        );

        assert(
            Number.isFinite(winnerPayload.serverTimestamp),
            "winner payload should include serverTimestamp"
        );

        // Final wheel position is immutable after the winner is determined.
        const angleAtResult = stopped.runtime.angle;

        for (let tick = 0; tick < 20; tick += 1) {

            stack.simulationLoop._onTick();

        }

        const afterResult = stack.physicsEngine.getSimulation(gameId);

        assert(
            afterResult.runtime.angle === angleAtResult,
            "final wheel angle must remain immutable after winner determination"
        );

        assert(
            winnerDeterminedCount === 1,
            "duplicate winner calculation must be impossible"
        );

        // The winning payload angle should reflect the frozen final angle.
        assert(
            winnerPayload.finalWheelAngle === angleAtResult,
            "winner payload angle should match the frozen final wheel angle"
        );

        console.log("  scenario 1 (winner determined once after stop) passed");

    } finally {

        stack.shutdown();

    }

}

// -------------------------------------------------------------------------
// Scenario 2: duplicate PHYSICS_STOPPED cannot re-trigger winner resolution.
// -------------------------------------------------------------------------

{

    const stack = buildStack();

    try {

        const gameId = "winner-activation-duplicate";

        activateGame(stack, gameId);

        let winnerDeterminedCount = 0;

        stack.eventBus.subscribe(EVENT_TYPES.WINNER_DETERMINED, () => {

            winnerDeterminedCount += 1;

        });

        stack.gameStateEngine.transition(gameId, GAME_STATES.BRAKE, {
            reason: "test"
        });

        let guard = 0;

        while (
            stack.gameStateEngine.getState(gameId) !== GAME_STATES.RESULT
            && guard < 1000
        ) {

            stack.simulationLoop._onTick();

            guard += 1;

        }

        assert(
            winnerDeterminedCount === 1,
            "winner should be determined exactly once"
        );

        // Re-emit PHYSICS_STOPPED manually; WinnerActivation must ignore it.
        stack.eventBus.emit({
            source: "PhysicsEngine",
            type: EVENT_TYPES.PHYSICS_STOPPED,
            payload: { gameId, angle: 0, angularVelocity: 0, timestamp: 0 }
        });

        assert(
            winnerDeterminedCount === 1,
            "duplicate PHYSICS_STOPPED must not re-determine the winner"
        );

        // The WinnerEngine itself refuses to resolve a second result.
        let secondResolveFailed = false;

        try {

            stack.winnerEngine.resolveResult(gameId);

        } catch (error) {

            secondResolveFailed = true;

        }

        assert(
            secondResolveFailed,
            "WinnerEngine must reject a duplicate result resolution"
        );

        console.log("  scenario 2 (duplicate winner calculation impossible) passed");

    } finally {

        stack.shutdown();

    }

}

console.log("gameplayWinnerActivation.integration.test.js: all assertions passed");
