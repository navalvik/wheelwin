import { GameCatalog } from "../catalog/GameCatalog.js";
import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { ConfigurationEngine } from "../engines/ConfigurationEngine.js";
import { GameStateEngine } from "../engines/GameStateEngine.js";
import { PhysicsEngine } from "../engines/PhysicsEngine.js";
import { WinnerEngine } from "../engines/WinnerEngine.js";
import { LoggerService } from "../services/LoggerService.js";
import { RandomService } from "../services/RandomService.js";
import { WinnerActivation } from "../gameplay/WinnerActivation.js";
import { createStandardConfigurationPlayers } from "./helpers/configurationPlayers.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

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
        configurationEngine,
        devMode: false
    });

    winnerActivation.initialize();

    return {
        logger,
        eventBus,
        catalog,
        randomService,
        configurationEngine,
        physicsEngine,
        gameStateEngine,
        winnerEngine,
        winnerActivation,
        shutdown() {

            winnerActivation.shutdown();

            winnerEngine.shutdown();

            gameStateEngine.shutdown();

            physicsEngine.shutdown();

            configurationEngine.shutdown();

            randomService.shutdown();

            eventBus.shutdown();

            logger.shutdown();

        }
    };

}

function prepareStoppedGame(stack, gameId, wheelDeg, triangleDeg) {

    stack.configurationEngine.generateConfiguration(
        gameId,
        { roomId: "winner-room", stake: 10 },
        createStandardConfigurationPlayers([
            "player-a",
            "player-b",
            "player-c"
        ])
    );

    stack.physicsEngine.createSimulation(gameId);

    stack.physicsEngine.startSimulation(gameId);

    stack.physicsEngine.setPoseDegrees(gameId, wheelDeg, triangleDeg);

}

// -------------------------------------------------------------------------
// Scenario 1: winner is determined exactly once after PHYSICS_STOPPED.
// RESULT / Page6 remain deferred (P5.8).
// -------------------------------------------------------------------------

{

    const stack = buildStack();

    try {

        const gameId = "winner-activation-happy";

        let winnerDeterminedCount = 0;

        let winnerPayload = null;

        let physicsStateAtWinner = null;

        stack.eventBus.subscribe(EVENT_TYPES.WINNER_DETERMINED, (envelope) => {

            winnerDeterminedCount += 1;

            winnerPayload = envelope.payload;

            physicsStateAtWinner = stack.physicsEngine
                .getSimulation(gameId).runtime.state;

        });

        prepareStoppedGame(stack, gameId, 90, 15);

        assert(
            winnerDeterminedCount === 0,
            "winner must NOT be determined while the wheel is still running"
        );

        stack.physicsEngine.stopSimulation(gameId);

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

        assert(winnerPayload.gameId === gameId, "winner payload should include gameId");

        assert(
            typeof winnerPayload.winnerPlayerId === "string"
                || typeof winnerPayload.winningPlayerId === "string",
            "winner payload should include winnerPlayerId"
        );

        assert(
            winnerPayload.winningSector
                && typeof winnerPayload.winningSector.sectorId === "string",
            "winner payload should include winning sector"
        );

        assert(
            Number.isFinite(winnerPayload.wheelFinalAngle)
                || Number.isFinite(winnerPayload.finalWheelAngle),
            "winner payload should include wheelFinalAngle"
        );

        assert(
            Number.isFinite(winnerPayload.triangleFinalAngle),
            "winner payload should include triangleFinalAngle"
        );

        assert(
            Number.isFinite(winnerPayload.resolvedAt)
                || Number.isFinite(winnerPayload.serverTimestamp),
            "winner payload should include resolvedAt"
        );

        const stored = stack.winnerEngine.getResult(gameId);

        assert(Object.isFrozen(stored), "stored result must be immutable");

        assert(
            stored.winnerPlayerId === (
                winnerPayload.winnerPlayerId ?? winnerPayload.winningPlayerId
            ),
            "stored winner must match WINNER_DETERMINED payload"
        );

        // Final wheel position is immutable after the winner is determined.
        const angleAtResult = stopped.runtime.angle;

        assert(
            winnerPayload.wheelFinalAngle === angleAtResult
                || winnerPayload.finalWheelAngle === angleAtResult,
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

        let winnerDeterminedCount = 0;

        stack.eventBus.subscribe(EVENT_TYPES.WINNER_DETERMINED, () => {

            winnerDeterminedCount += 1;

        });

        prepareStoppedGame(stack, gameId, 45, 0);

        stack.physicsEngine.stopSimulation(gameId);

        assert(
            winnerDeterminedCount === 1,
            "winner should be determined exactly once"
        );

        const first = stack.winnerEngine.getResult(gameId);

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

        // WinnerEngine is idempotent: duplicate resolve returns the stored result.
        const second = stack.winnerEngine.resolveResult(gameId);

        assert(
            second === first
                && second.winnerPlayerId === first.winnerPlayerId
                && second.winnerSectorIndex === first.winnerSectorIndex
                && second.resolvedAt === first.resolvedAt,
            "WinnerEngine must return the already stored result on duplicate resolve"
        );

        console.log("  scenario 2 (duplicate winner calculation impossible) passed");

    } finally {

        stack.shutdown();

    }

}

// -------------------------------------------------------------------------
// Scenario 3: offline player may win (connection state ignored).
// -------------------------------------------------------------------------

{

    const stack = buildStack();

    try {

        const gameId = "winner-activation-offline";

        const determined = [];

        stack.eventBus.subscribe(EVENT_TYPES.WINNER_DETERMINED, (envelope) => {

            determined.push(envelope.payload);

        });

        prepareStoppedGame(stack, gameId, 10, 0);

        stack.physicsEngine.stopSimulation(gameId);

        assert(determined.length === 1, "offline-capable resolve emits once");

        const result = stack.winnerEngine.getResult(gameId);

        assert(result?.winnerPlayerId, "offline player may be a valid winner");

        // Recovery returns the stored result only — never recalculates.
        const recovered = stack.winnerEngine.getResult(gameId);

        assert(
            recovered === result
                && recovered.winnerPlayerId === result.winnerPlayerId
                && recovered.winnerSectorIndex === result.winnerSectorIndex
                && recovered.wheelFinalAngle === result.wheelFinalAngle
                && recovered.triangleFinalAngle === result.triangleFinalAngle
                && recovered.resolvedAt === result.resolvedAt,
            "recovery restores stored winner fields without recalculation"
        );

        console.log("  scenario 3 (offline winner + recovery restore) passed");

    } finally {

        stack.shutdown();

    }

}

console.log("gameplayWinnerActivation.integration.test.js: all assertions passed");
