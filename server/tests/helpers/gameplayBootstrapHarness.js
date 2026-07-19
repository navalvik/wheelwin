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
import { SpeedActivation } from "../../gameplay/SpeedActivation.js";
import { OfflineInputContinuation } from "../../gameplay/OfflineInputContinuation.js";
import { WinnerActivation } from "../../gameplay/WinnerActivation.js";
import { PaymentActivation } from "../../gameplay/PaymentActivation.js";
import { GameplayLifecycle } from "../../gameplay/GameplayLifecycle.js";
import { SetupSessionLifecycle } from "../../gameplay/SetupSessionLifecycle.js";
import { GameplayTimerLifecycle } from "../../gameplay/GameplayTimerLifecycle.js";
import { GameplayTimerActivation } from "../../gameplay/GameplayTimerActivation.js";
import { PaymentEngine } from "../../engines/PaymentEngine.js";
import { TelegramWalletAdapter } from "../../services/telegram/TelegramWalletAdapter.js";
import { EVENT_SOURCES } from "../../events/EventSources.js";
import { EVENT_TYPES } from "../../events/EventTypes.js";

/**
 * R1.1 — After room-full prep, emit entry-payment completion so GameManager
 * starts physics / clock / READY. Used by tests that skip the lobby payment UI.
 */
export function emitEntryPaymentCompleted(eventBus, roomId) {

    if (!eventBus || !roomId) {

        return;

    }

    eventBus.emit({
        source: EVENT_SOURCES.ROOM_LOBBY_BRIDGE,
        type: EVENT_TYPES.ENTRY_PAYMENT_COMPLETED,
        payload: { roomId }
    });

}

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
    enableLifecycle = false,
    walletAdapter = null,
    setupDurationMs = 10 * 60 * 1000,
    gameplayDurationMs = 5 * 60 * 1000,
    gameplayWarningMs = 30 * 1000,
    deferGameBootstrap = false
}) {

    const setupSessionLifecycle = new SetupSessionLifecycle({
        logger,
        eventBus,
        roomManager,
        roomConfig: { setupDurationMs },
        devMode
    });

    setupSessionLifecycle.initialize();

    roomManager.attachSetupSessionLifecycle(setupSessionLifecycle);

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

    const fastInputCatalog = createFastInputCatalog(catalog);

    const inputAuthority = new InputAuthority({
        logger,
        eventBus,
        gameCatalog: fastInputCatalog,
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

    const speedActivation = new SpeedActivation({
        logger,
        eventBus,
        gameClockEngine,
        gameStateEngine,
        devMode
    });

    speedActivation.initialize();

    const offlineInputContinuation = new OfflineInputContinuation({
        logger,
        eventBus,
        inputAuthority,
        gameStateEngine,
        playerManager,
        gameCatalog: fastInputCatalog,
        devMode
    });

    offlineInputContinuation.initialize();

    const winnerActivation = new WinnerActivation({
        logger,
        eventBus,
        physicsEngine,
        winnerEngine,
        gameStateEngine,
        devMode
    });

    winnerActivation.initialize();

    const gameplayTimerLifecycle = new GameplayTimerLifecycle({
        logger,
        eventBus,
        gameplayTimerConfig: {
            gameplayDurationMs,
            gameplayWarningMs
        },
        devMode
    });

    gameplayTimerLifecycle.initialize();

    const gameplayTimerActivation = new GameplayTimerActivation({
        logger,
        eventBus,
        gameClockEngine,
        gameStateEngine,
        devMode
    });

    gameplayTimerActivation.initialize();

    const paymentEngine = new PaymentEngine({
        logger,
        eventBus,
        winnerEngine,
        configurationEngine,
        gameCatalog: catalog,
        telegramWalletAdapter: walletAdapter
            ?? new TelegramWalletAdapter({ logger })
    });

    paymentEngine.initialize();

    const paymentActivation = new PaymentActivation({
        logger,
        eventBus,
        paymentEngine,
        devMode
    });

    paymentActivation.initialize();

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
            speedActivation,
            offlineInputContinuation,
            paymentEngine,
            paymentActivation,
            gameManager,
            devMode
        });

        gameplayLifecycle.initialize();

    }

    if (!deferGameBootstrap) {

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

    }

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
        speedActivation,
        offlineInputContinuation,
        winnerEngine,
        winnerActivation,
        gameplayTimerLifecycle,
        gameplayTimerActivation,
        paymentEngine,
        paymentActivation,
        gameplayLifecycle,
        setupSessionLifecycle
    };

}

export function shutdownGameplayBootstrap(engines) {

    if (!engines) {

        return;

    }

    if (engines.gameplayLifecycle) {

        engines.gameplayLifecycle.shutdown();

    }

    if (engines.gameplayTimerActivation) {

        engines.gameplayTimerActivation.shutdown();

    }

    if (engines.gameplayTimerLifecycle) {

        engines.gameplayTimerLifecycle.shutdown();

    }

    if (engines.setupSessionLifecycle) {

        engines.setupSessionLifecycle.shutdown();

    }

    engines.paymentActivation.shutdown();

    engines.paymentEngine.shutdown();

    engines.winnerActivation.shutdown();

    engines.offlineInputContinuation.shutdown();

    engines.speedActivation.shutdown();

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

/**
 * Exhaust every player's authoritative input budget during SPEED so
 * SpeedActivation can complete the phase via PLAYER_PRESS_LIMIT_REACHED.
 */
export function exhaustAllPlayerInput(
    inputAuthority,
    gameId,
    playerIds,
    maxPressCycles = INPUT_RULES.maxPressCycles
) {

    for (const playerId of playerIds) {

        for (let cycle = 0; cycle < maxPressCycles; cycle += 1) {

            inputAuthority.handleButtonPress(gameId, playerId);

            inputAuthority.handleButtonRelease(gameId, playerId);

        }

    }

}
