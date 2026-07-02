import { GameCatalog } from "../catalog/GameCatalog.js";
import { INPUT_RULES } from "../catalog/InputRules.js";
import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { ConfigurationEngine } from "../engines/ConfigurationEngine.js";
import { GameStateEngine } from "../engines/GameStateEngine.js";
import { PhysicsEngine } from "../engines/PhysicsEngine.js";
import { WinnerEngine } from "../engines/WinnerEngine.js";
import { PaymentEngine } from "../engines/PaymentEngine.js";
import { GAME_STATES } from "../engines/gameState/GameStates.js";
import { InputAuthority } from "../input/InputAuthority.js";
import { PLAYER_STATE } from "../models/PlayerState.js";
import { PlayerManager } from "../managers/PlayerManager.js";
import { LoggerService } from "../services/LoggerService.js";
import { RandomService } from "../services/RandomService.js";
import { TelegramWalletAdapter } from "../services/telegram/TelegramWalletAdapter.js";
import { SimulationLoop } from "../simulation/SimulationLoop.js";
import { WinnerActivation } from "../gameplay/WinnerActivation.js";
import { PaymentActivation } from "../gameplay/PaymentActivation.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

function buildStack({ walletAdapter = null } = {}) {

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

    randomService.setSeed(4321);

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
        gameCatalog: {
            getInputRules: () => ({ ...INPUT_RULES, pressCooldownMs: 0 }),
            getColors: () => catalog.getColors(),
            getIcons: () => catalog.getIcons(),
            getStakes: () => catalog.getStakes(),
            getTimers: () => catalog.getTimers(),
            getWheelRules: () => catalog.getWheelRules()
        },
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
        devMode: false
    });

    paymentActivation.initialize();

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
        paymentEngine,
        paymentActivation,
        shutdown() {

            paymentActivation.shutdown();

            paymentEngine.shutdown();

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
        { roomId: "payment-room", stake: 10 },
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

function runToResult(stack, gameId, players) {

    for (const playerId of players) {

        stack.inputAuthority.handleButtonPress(gameId, playerId);

    }

    for (let tick = 0; tick < 10; tick += 1) {

        stack.simulationLoop._onTick();

    }

    stack.gameStateEngine.transition(gameId, GAME_STATES.BRAKE, {
        reason: "test"
    });

    let guard = 0;

    while (
        stack.gameStateEngine.getState(gameId) !== GAME_STATES.RESULT
        && guard < 2000
    ) {

        stack.simulationLoop._onTick();

        guard += 1;

    }

    assert(guard < 2000, "game should reach RESULT");

}

// ---------------------------------------------------------------------------
// Scenario 1 — successful settlement after winner determination.
// ---------------------------------------------------------------------------

{

    const stack = buildStack();

    try {

        const gameId = "payment-success";

        const { players } = activateGame(stack, gameId);

        let winnerDeterminedCount = 0;

        let paymentStartedCount = 0;

        let paymentCompletedCount = 0;

        let paymentFailedCount = 0;

        let winningPlayerId = null;

        let winnerResultExistedAtPaymentStart = null;

        let paymentBeforeStop = 0;

        stack.eventBus.subscribe(EVENT_TYPES.WINNER_DETERMINED, (envelope) => {

            winnerDeterminedCount += 1;

            winningPlayerId = envelope.payload.winningPlayerId;

        });

        stack.eventBus.subscribe(EVENT_TYPES.PAYMENT_STARTED, () => {

            paymentStartedCount += 1;

            winnerResultExistedAtPaymentStart = Boolean(
                stack.winnerEngine.getResult(gameId)
            );

        });

        stack.eventBus.subscribe(EVENT_TYPES.PAYMENT_COMPLETED, () => {

            paymentCompletedCount += 1;

        });

        stack.eventBus.subscribe(EVENT_TYPES.PAYMENT_FAILED, () => {

            paymentFailedCount += 1;

        });

        // Drive the wheel; assert no settlement occurs while it is still moving.
        for (const playerId of players) {

            stack.inputAuthority.handleButtonPress(gameId, playerId);

        }

        for (let tick = 0; tick < 8; tick += 1) {

            stack.simulationLoop._onTick();

        }

        paymentBeforeStop = paymentStartedCount;

        assert(
            paymentBeforeStop === 0,
            "settlement must NOT start while the wheel is still moving"
        );

        stack.gameStateEngine.transition(gameId, GAME_STATES.BRAKE, {
            reason: "test"
        });

        let guard = 0;

        while (
            stack.gameStateEngine.getState(gameId) !== GAME_STATES.RESULT
            && guard < 2000
        ) {

            stack.simulationLoop._onTick();

            guard += 1;

        }

        assert(guard < 2000, "game should reach RESULT");

        assert(
            winnerDeterminedCount === 1,
            "winner should be determined exactly once"
        );

        assert(
            paymentStartedCount === 1,
            "PAYMENT_STARTED must be emitted exactly once"
        );

        assert(
            paymentCompletedCount === 1,
            "PAYMENT_COMPLETED must be emitted exactly once"
        );

        assert(
            paymentFailedCount === 0,
            "PAYMENT_FAILED must not fire for a successful settlement"
        );

        assert(
            winnerResultExistedAtPaymentStart === true,
            "settlement must begin only after the winner is determined"
        );

        // Winner immutability across settlement.
        const finalResult = stack.winnerEngine.getResult(gameId);

        assert(
            finalResult.winningPlayer.playerId === winningPlayerId,
            "winner must not change during settlement"
        );

        const payment = stack.paymentEngine.getPayment(gameId);

        assert(payment, "completed payment record should exist");

        assert(
            payment.winnerId === winningPlayerId,
            "payment winner must match the authoritative winner"
        );

        assert(
            stack.gameStateEngine.getState(gameId) === GAME_STATES.RESULT,
            "GameState should remain RESULT after settlement"
        );

        // Duplicate WINNER_DETERMINED must not start a second settlement.
        stack.eventBus.emit({
            source: "WinnerEngine",
            type: EVENT_TYPES.WINNER_DETERMINED,
            payload: { gameId, winningPlayerId }
        });

        assert(
            paymentStartedCount === 1,
            "duplicate WINNER_DETERMINED must not restart settlement"
        );

        console.log("  scenario 1 (successful settlement) passed");

    } finally {

        stack.shutdown();

    }

}

// ---------------------------------------------------------------------------
// Scenario 2 — settlement failure never affects the immutable game result.
// ---------------------------------------------------------------------------

{

    const failingAdapter = {
        preparePayment({ gameId, winnerId, amount, currency, metadata }) {

            return {
                paymentReference: `tg_wallet_test_${gameId}`,
                gameId,
                winnerId,
                amount,
                currency,
                status: "prepared",
                metadata: { ...metadata },
                preparedAt: Date.now()
            };

        },
        executeTransfer() {

            throw new Error("Simulated wallet failure");

        }
    };

    const stack = buildStack({ walletAdapter: failingAdapter });

    try {

        const gameId = "payment-failure";

        const { players } = activateGame(stack, gameId);

        let paymentStartedCount = 0;

        let paymentCompletedCount = 0;

        let paymentFailedCount = 0;

        stack.eventBus.subscribe(EVENT_TYPES.PAYMENT_STARTED, () => {

            paymentStartedCount += 1;

        });

        stack.eventBus.subscribe(EVENT_TYPES.PAYMENT_COMPLETED, () => {

            paymentCompletedCount += 1;

        });

        stack.eventBus.subscribe(EVENT_TYPES.PAYMENT_FAILED, () => {

            paymentFailedCount += 1;

        });

        runToResult(stack, gameId, players);

        const winnerResult = stack.winnerEngine.getResult(gameId);

        assert(winnerResult, "winner should still be determined despite failure");

        assert(
            paymentStartedCount === 1,
            "PAYMENT_STARTED should still fire exactly once on failure path"
        );

        assert(
            paymentFailedCount === 1,
            "PAYMENT_FAILED must be emitted exactly once on simulated failure"
        );

        assert(
            paymentCompletedCount === 0,
            "PAYMENT_COMPLETED must not fire when settlement fails"
        );

        // Failure must not corrupt the immutable authoritative result / state.
        assert(
            winnerResult.winningPlayer?.playerId,
            "winner result must remain intact after payment failure"
        );

        assert(
            stack.gameStateEngine.getState(gameId) === GAME_STATES.RESULT,
            "GameState must remain RESULT after payment failure"
        );

        assert(
            stack.paymentEngine.getPaymentStatus(gameId) === "FAILED",
            "payment status should be FAILED"
        );

        console.log("  scenario 2 (settlement failure isolated) passed");

    } finally {

        stack.shutdown();

    }

}

console.log(
    "gameplayPaymentSettlement.integration.test.js: all assertions passed"
);
