import { GameCatalog } from "../../catalog/GameCatalog.js";
import { INPUT_RULES } from "../../catalog/InputRules.js";
import { TIMER_PHASES } from "../../catalog/Timers.js";
import { ConfigurationEngine } from "../../engines/ConfigurationEngine.js";
import { GameClockEngine } from "../../engines/GameClockEngine.js";
import { GameStateEngine } from "../../engines/GameStateEngine.js";
import { PhysicsEngine } from "../../engines/PhysicsEngine.js";
import { InputAuthority } from "../../input/InputAuthority.js";
import { LoggerService } from "../../services/LoggerService.js";
import { RandomService } from "../../services/RandomService.js";
import { SimulationLoop } from "../../simulation/SimulationLoop.js";
import { WinnerEngine } from "../../engines/WinnerEngine.js";
import { GameStateActivation } from "../../gameplay/GameStateActivation.js";
import { WinnerActivation } from "../../gameplay/WinnerActivation.js";
import { GameplayLifecycle } from "../../gameplay/GameplayLifecycle.js";

export function createFastTimers() {

    return {
        [TIMER_PHASES.COUNTDOWN]: {
            phase: TIMER_PHASES.COUNTDOWN,
            durationMs: 25
        },
        [TIMER_PHASES.SELF_TEST]: {
            phase: TIMER_PHASES.SELF_TEST,
            durationMs: 25
        },
        [TIMER_PHASES.SPEED]: {
            phase: TIMER_PHASES.SPEED,
            durationMs: null
        },
        [TIMER_PHASES.BRAKE]: {
            phase: TIMER_PHASES.BRAKE,
            durationMs: 25
        },
        [TIMER_PHASES.RESULT]: {
            phase: TIMER_PHASES.RESULT,
            durationMs: 25
        }
    };

}

export function createFastInputCatalog(catalog) {

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

export function wireGameplayBootstrap({
    gameManager,
    roomManager,
    playerManager,
    logger,
    eventBus,
    gameplayContextResolver = null,
    devMode = true,
    enableLifecycle = false
}) {

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

    configurationEngine.initialize();

    physicsEngine.initialize();

    inputAuthority.initialize();

    const simulationLoop = new SimulationLoop({
        logger,
        eventBus,
        physicsEngine,
        inputAuthority,
        devMode
    });

    simulationLoop.initialize();

    simulationLoop.start();

    const winnerEngine = new WinnerEngine({
        logger,
        eventBus,
        physicsEngine,
        configurationEngine,
        gameCatalog: catalog
    });

    winnerEngine.initialize();

    const gameStateActivation = new GameStateActivation({
        logger,
        eventBus,
        gameStateEngine,
        gameClockEngine,
        devMode
    });

    gameStateActivation.initialize();

    const winnerActivation = new WinnerActivation({
        logger,
        eventBus,
        physicsEngine,
        winnerEngine,
        gameStateEngine,
        devMode
    });

    winnerActivation.initialize();

    let gameplayLifecycle = null;

    if (enableLifecycle) {

        gameplayLifecycle = new GameplayLifecycle({
            logger,
            eventBus,
            gameCatalog: catalog,
            physicsEngine,
            inputAuthority,
            gameClockEngine,
            gameStateEngine,
            configurationEngine,
            winnerEngine,
            winnerActivation,
            gameManager,
            devMode
        });

        gameplayLifecycle.initialize();

    }

    gameManager.configureGameplayBootstrap({
        roomManager,
        playerManager,
        configurationEngine,
        gameStateEngine,
        inputAuthority,
        physicsEngine,
        gameClockEngine,
        gameCatalog: catalog,
        gameplayContextResolver,
        devMode
    });

    return {
        catalog,
        randomService,
        configurationEngine,
        gameStateEngine,
        gameClockEngine,
        physicsEngine,
        inputAuthority,
        simulationLoop,
        gameStateActivation,
        winnerEngine,
        winnerActivation,
        gameplayLifecycle
    };

}

export function shutdownGameplayBootstrap(engines) {

    if (!engines) {

        return;

    }

    if (engines.gameplayLifecycle) {

        engines.gameplayLifecycle.shutdown();

    }

    engines.winnerActivation.shutdown();

    engines.winnerEngine.shutdown();

    engines.gameStateActivation.shutdown();

    engines.simulationLoop.shutdown();

    engines.inputAuthority.shutdown();

    engines.physicsEngine.shutdown();

    engines.gameClockEngine.shutdown();

    engines.gameStateEngine.shutdown();

    engines.configurationEngine.shutdown();

    engines.randomService.shutdown();

}
