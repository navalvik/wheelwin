import { GameCatalog } from "../catalog/GameCatalog.js";
import { PAYMENT_STATUS } from "../catalog/PaymentRules.js";
import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { ConfigurationEngine } from "../engines/ConfigurationEngine.js";
import { GameClockEngine } from "../engines/GameClockEngine.js";
import { GameStateEngine } from "../engines/GameStateEngine.js";
import { GAME_STATES } from "../engines/gameState/GameStates.js";
import { PaymentEngine } from "../engines/PaymentEngine.js";
import { PhysicsEngine } from "../engines/PhysicsEngine.js";
import { RecoveryEngine } from "../engines/RecoveryEngine.js";
import { RecoveryValidationError } from "../engines/recovery/RecoveryValidationError.js";
import { WinnerEngine } from "../engines/WinnerEngine.js";
import { InputAuthority } from "../input/InputAuthority.js";
import { PlayerManager } from "../managers/PlayerManager.js";
import { LoggerService } from "../services/LoggerService.js";
import { RandomService } from "../services/RandomService.js";
import { TelegramWalletAdapter } from "../services/telegram/TelegramWalletAdapter.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

function createRecoveryStack() {

    const logger = new LoggerService();

    logger.initialize();

    const catalog = new GameCatalog({ logger });

    catalog.initialize();

    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    const randomService = new RandomService({ logger });

    randomService.initialize();

    randomService.setSeed(11);

    const configurationEngine = new ConfigurationEngine({
        logger,
        eventBus,
        gameCatalog: catalog,
        randomService
    });

    configurationEngine.initialize();

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

    const playerManager = new PlayerManager({ logger, eventBus });

    playerManager.initialize();

    const inputAuthority = new InputAuthority({
        logger,
        eventBus,
        gameCatalog: catalog,
        playerManager,
        physicsEngine,
        gameStateEngine
    });

    inputAuthority.initialize();

    const winnerEngine = new WinnerEngine({
        logger,
        eventBus,
        physicsEngine,
        configurationEngine,
        gameCatalog: catalog
    });

    winnerEngine.initialize();

    const paymentEngine = new PaymentEngine({
        logger,
        eventBus,
        winnerEngine,
        configurationEngine,
        gameCatalog: catalog,
        telegramWalletAdapter: new TelegramWalletAdapter({ logger })
    });

    paymentEngine.initialize();

    const recoveryEngine = new RecoveryEngine({
        logger,
        eventBus,
        gameCatalog: catalog,
        configurationEngine,
        gameStateEngine,
        gameClock: gameClockEngine,
        physicsEngine,
        inputAuthority,
        winnerEngine,
        paymentEngine
    });

    recoveryEngine.initialize();

    return {
        logger,
        catalog,
        eventBus,
        configurationEngine,
        gameStateEngine,
        gameClockEngine,
        physicsEngine,
        inputAuthority,
        winnerEngine,
        paymentEngine,
        recoveryEngine,
        shutdown() {

            recoveryEngine.shutdown();

            paymentEngine.shutdown();

            winnerEngine.shutdown();

            inputAuthority.shutdown();

            playerManager.shutdown();

            physicsEngine.shutdown();

            gameClockEngine.shutdown();

            gameStateEngine.shutdown();

            configurationEngine.shutdown();

            eventBus.shutdown();

            randomService.shutdown();

            logger.shutdown();

        }
    };

}

function setupActiveGame(stack, gameId, playerIds) {

    const {
        configurationEngine,
        gameStateEngine,
        gameClockEngine,
        physicsEngine,
        inputAuthority
    } = stack;

    configurationEngine.generateConfiguration(
        gameId,
        { roomId: `room-${gameId}`, stake: 10 },
        playerIds.map((playerId) => ({
            playerId,
            sectorCount: 2
        }))
    );

    gameStateEngine.initializeGameState(gameId);

    gameStateEngine.transition(gameId, GAME_STATES.READY, { reason: "test" });

    gameStateEngine.transition(gameId, GAME_STATES.SELF_TEST, { reason: "test" });

    gameStateEngine.transition(gameId, GAME_STATES.SPEED, { reason: "test" });

    gameClockEngine.createClock(gameId);

    gameClockEngine.startClock(gameId);

    physicsEngine.createSimulation(gameId);

    physicsEngine.startSimulation(gameId);

    for (const playerId of playerIds) {

        inputAuthority.registerPlayer(gameId, playerId);

    }

}

function teardownGame(stack, gameId, playerIds) {

    const {
        configurationEngine,
        gameStateEngine,
        gameClockEngine,
        physicsEngine,
        inputAuthority,
        winnerEngine,
        paymentEngine,
        recoveryEngine
    } = stack;

    recoveryEngine.removeRecoverySnapshot(gameId);

    paymentEngine.removePayment(gameId);

    winnerEngine.removeResult(gameId);

    gameClockEngine.stopClock(gameId);

    gameClockEngine.removeClock(gameId);

    physicsEngine.stopSimulation(gameId);

    physicsEngine.removeSimulation(gameId);

    gameStateEngine.removeState(gameId);

    for (const playerId of playerIds) {

        inputAuthority.removePlayer(gameId, playerId);

    }

    configurationEngine.removeConfiguration(gameId);

}

const stack = createRecoveryStack();

const activeGameId = "recovery-active-game";

const completedGameId = "recovery-completed-game";

const restartGameId = "recovery-restart-game";

const multiGameA = "recovery-multi-a";

const multiGameB = "recovery-multi-b";

const activePlayers = [
    "recovery-player-1",
    "recovery-player-2",
    "recovery-player-3"
];

setupActiveGame(stack, activeGameId, activePlayers);

const playerSnapshot = stack.recoveryEngine.recoverPlayer(
    activeGameId,
    activePlayers[0]
);

assert(playerSnapshot.gameId === activeGameId, "player recovery should return snapshot");

assert(
    playerSnapshot.input.players.some(
        (player) => player.playerId === activePlayers[0]
    ),
    "player recovery snapshot should include target player input"
);

assert(
    stack.recoveryEngine.getRecoverySnapshot(activeGameId) !== null,
    "player recovery should cache snapshot"
);

teardownGame(stack, activeGameId, activePlayers);

setupActiveGame(stack, completedGameId, activePlayers);

stack.physicsEngine.stopSimulation(completedGameId);

stack.gameStateEngine.transition(
    completedGameId,
    GAME_STATES.BRAKE,
    { reason: "test" }
);

stack.gameStateEngine.transition(
    completedGameId,
    GAME_STATES.RESULT,
    { reason: "test" }
);

stack.winnerEngine.resolveResult(completedGameId);

stack.paymentEngine.preparePayment(completedGameId);

stack.paymentEngine.processPayment(completedGameId);

const completedSnapshot = stack.recoveryEngine.recoverSession(completedGameId);

assert(completedSnapshot.winner !== null, "completed game should include winner");

assert(
    completedSnapshot.payment.paymentStatus === PAYMENT_STATUS.COMPLETED,
    "completed game should include payment result"
);

assert(
    completedSnapshot.gameState.currentState === GAME_STATES.RESULT,
    "completed game snapshot should reflect result state"
);

teardownGame(stack, completedGameId, activePlayers);

setupActiveGame(stack, restartGameId, activePlayers);

stack.recoveryEngine.buildRecoverySnapshot(restartGameId);

stack.recoveryEngine.removeRecoverySnapshot(restartGameId);

const restartSnapshot = stack.recoveryEngine.recoverSession(restartGameId);

assert(
    restartSnapshot.physics.snapshot !== null,
    "server restart recovery should include physics snapshot"
);

assert(
    restartSnapshot.clock !== null,
    "server restart recovery should include clock state"
);

assert(
    restartSnapshot.configuration !== null,
    "server restart recovery should include configuration"
);

assert(Object.isFrozen(restartSnapshot), "recovery snapshot root should be frozen");

let mutationRejected = false;

try {

    restartSnapshot.gameId = "mutated";

    mutationRejected = restartSnapshot.gameId === "mutated";

} catch {

    mutationRejected = false;

}

assert(!mutationRejected, "recovery snapshot should remain immutable");

let missingPhysicsRejected = false;

try {

    stack.recoveryEngine.buildRecoverySnapshot("missing-game");

} catch (error) {

    missingPhysicsRejected = error instanceof RecoveryValidationError;

}

assert(missingPhysicsRejected, "missing dependencies should be rejected");

const emitted = [];

for (const type of [
    EVENT_TYPES.RECOVERY_STARTED,
    EVENT_TYPES.RECOVERY_SNAPSHOT_CREATED,
    EVENT_TYPES.SESSION_RECOVERED,
    EVENT_TYPES.RECOVERY_REMOVED
]) {

    stack.eventBus.subscribe(type, (envelope) => {

        if (envelope.payload.gameId === restartGameId) {

            emitted.push(type);

        }

    });

}

stack.recoveryEngine.removeRecoverySnapshot(restartGameId);

stack.recoveryEngine.recoverSession(restartGameId);

stack.recoveryEngine.removeRecoverySnapshot(restartGameId);

assert(
    emitted.includes(EVENT_TYPES.RECOVERY_STARTED),
    "recovery should emit RECOVERY_STARTED"
);

assert(
    emitted.includes(EVENT_TYPES.RECOVERY_SNAPSHOT_CREATED),
    "recovery should emit RECOVERY_SNAPSHOT_CREATED"
);

assert(
    emitted.includes(EVENT_TYPES.SESSION_RECOVERED),
    "recovery should emit SESSION_RECOVERED"
);

assert(
    emitted.includes(EVENT_TYPES.RECOVERY_REMOVED),
    "recovery should emit RECOVERY_REMOVED"
);

teardownGame(stack, restartGameId, activePlayers);

setupActiveGame(stack, multiGameA, activePlayers);

setupActiveGame(stack, multiGameB, [
    "recovery-multi-player-1",
    "recovery-multi-player-2",
    "recovery-multi-player-3"
]);

const snapshotA = stack.recoveryEngine.recoverSession(multiGameA);

const snapshotB = stack.recoveryEngine.recoverSession(multiGameB);

assert(snapshotA.gameId === multiGameA, "first multi-game snapshot should match");

assert(snapshotB.gameId === multiGameB, "second multi-game snapshot should match");

assert(
    stack.recoveryEngine.getRecoverySnapshot(multiGameA).gameId === multiGameA,
    "multi-game snapshots should remain isolated"
);

assert(
    stack.recoveryEngine.getRecoverySnapshot(multiGameB).gameId === multiGameB,
    "multi-game snapshots should remain isolated"
);

teardownGame(stack, multiGameA, activePlayers);

teardownGame(stack, multiGameB, [
    "recovery-multi-player-1",
    "recovery-multi-player-2",
    "recovery-multi-player-3"
]);

stack.shutdown();

console.log("RecoveryEngine tests passed");
