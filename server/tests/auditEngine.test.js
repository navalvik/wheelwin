import { GameCatalog } from "../catalog/GameCatalog.js";
import { PAYMENT_STATUS } from "../catalog/PaymentRules.js";
import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { AuditVerifier } from "../engines/audit/AuditVerifier.js";
import { AuditValidationError } from "../engines/audit/AuditValidationError.js";
import { ConfigurationEngine } from "../engines/ConfigurationEngine.js";
import { AuditEngine } from "../engines/AuditEngine.js";
import { GameClockEngine } from "../engines/GameClockEngine.js";
import { GameStateEngine } from "../engines/GameStateEngine.js";
import { GAME_STATES } from "../engines/gameState/GameStates.js";
import { PaymentEngine } from "../engines/PaymentEngine.js";
import { PhysicsEngine } from "../engines/PhysicsEngine.js";
import { RecoveryEngine } from "../engines/RecoveryEngine.js";
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

function createAuditStack() {

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

    randomService.setSeed(19);

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

    const auditEngine = new AuditEngine({
        logger,
        eventBus,
        gameCatalog: catalog,
        configurationEngine,
        gameStateEngine,
        gameClock: gameClockEngine,
        physicsEngine,
        inputAuthority,
        winnerEngine,
        paymentEngine,
        recoveryEngine
    });

    auditEngine.initialize();

    return {
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
        auditEngine,
        shutdown() {

            auditEngine.shutdown();

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

function setupCompletedGame(stack, gameId, playerIds) {

    const {
        configurationEngine,
        gameStateEngine,
        gameClockEngine,
        physicsEngine,
        inputAuthority,
        winnerEngine,
        paymentEngine
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

    gameStateEngine.transition(gameId, GAME_STATES.BRAKE, { reason: "test" });

    gameStateEngine.transition(gameId, GAME_STATES.RESULT, { reason: "test" });

    gameClockEngine.createClock(gameId);

    gameClockEngine.startClock(gameId);

    gameClockEngine.stopClock(gameId);

    physicsEngine.createSimulation(gameId);

    physicsEngine.startSimulation(gameId);

    physicsEngine.stopSimulation(gameId);

    for (const playerId of playerIds) {

        inputAuthority.registerPlayer(gameId, playerId);

    }

    winnerEngine.resolveResult(gameId);

    paymentEngine.preparePayment(gameId);

    paymentEngine.processPayment(gameId);

}

function teardownCompletedGame(stack, gameId, playerIds) {

    const {
        configurationEngine,
        gameStateEngine,
        gameClockEngine,
        physicsEngine,
        inputAuthority,
        winnerEngine,
        paymentEngine,
        recoveryEngine,
        auditEngine
    } = stack;

    auditEngine.removeAuditReport(gameId);

    recoveryEngine.removeRecoverySnapshot(gameId);

    paymentEngine.removePayment(gameId);

    winnerEngine.removeResult(gameId);

    gameClockEngine.removeClock(gameId);

    physicsEngine.removeSimulation(gameId);

    gameStateEngine.removeState(gameId);

    for (const playerId of playerIds) {

        inputAuthority.removePlayer(gameId, playerId);

    }

    configurationEngine.removeConfiguration(gameId);

}

const stack = createAuditStack();

const verifier = new AuditVerifier({ gameCatalog: stack.catalog });

const validGameId = "audit-valid-game";

const multiGameA = "audit-multi-a";

const multiGameB = "audit-multi-b";

const playerIds = [
    "audit-player-1",
    "audit-player-2",
    "audit-player-3"
];

setupCompletedGame(stack, validGameId, playerIds);

const validReport = stack.auditEngine.buildAuditReport(validGameId);

assert(validReport.verification.passed, "valid completed game should pass audit");

assert(Object.isFrozen(validReport), "audit report should be frozen");

assert(
    validReport.winner !== null && validReport.payment !== null,
    "audit report should include winner and payment"
);

const invalidConfiguration = verifier.verifyConfiguration({
    gameId: "bad-config",
    configurationVersion: "1.0",
    stake: 999,
    players: [],
    sectors: [],
    timers: {},
    traceSeed: "seed"
});

assert(!invalidConfiguration.passed, "invalid configuration should fail verification");

const invalidStateHistory = verifier.verifyGameState([
    { state: GAME_STATES.READY, enteredAt: 1, reason: "test" },
    { state: GAME_STATES.SPEED, enteredAt: 2, reason: "test" }
]);

assert(!invalidStateHistory.passed, "invalid state history should fail verification");

let missingPhysicsRejected = false;

try {

    stack.auditEngine.buildAuditReport("missing-physics-game");

} catch (error) {

    missingPhysicsRejected = error instanceof AuditValidationError;

}

assert(missingPhysicsRejected, "missing physics snapshot should be rejected");

const completedSources = {
    configuration: stack.configurationEngine.getConfiguration(validGameId),
    physics: stack.physicsEngine.getSimulation(validGameId),
    winner: stack.winnerEngine.getResult(validGameId),
    payment: stack.paymentEngine.getPayment(validGameId)
};

const mismatchedWinner = {
    ...completedSources.winner,
    finalAngle: completedSources.winner.finalAngle + 1
};

const winnerMismatch = verifier.verifyWinner(
    mismatchedWinner,
    completedSources.configuration,
    completedSources.physics
);

assert(!winnerMismatch.passed, "winner mismatch should be detected");

const mismatchedPayment = {
    ...completedSources.payment,
    winnerAmount: completedSources.payment.winnerAmount + 1
};

const paymentMismatch = verifier.verifyPayment(
    mismatchedPayment,
    completedSources.winner,
    completedSources.configuration
);

assert(!paymentMismatch.passed, "payment mismatch should be detected");

let mutationRejected = false;

try {

    validReport.gameId = "mutated";

    mutationRejected = validReport.gameId === "mutated";

} catch {

    mutationRejected = false;

}

assert(!mutationRejected, "audit report should remain immutable");

const emitted = [];

for (const type of [
    EVENT_TYPES.AUDIT_STARTED,
    EVENT_TYPES.AUDIT_REPORT_CREATED,
    EVENT_TYPES.AUDIT_COMPLETED
]) {

    stack.eventBus.subscribe(type, (envelope) => {

        if (envelope.payload.gameId === validGameId) {

            emitted.push(type);

        }

    });

}

stack.auditEngine.verifyGame(validGameId);

assert(emitted.includes(EVENT_TYPES.AUDIT_STARTED), "audit should emit AUDIT_STARTED");

assert(emitted.includes(EVENT_TYPES.AUDIT_COMPLETED), "audit should emit AUDIT_COMPLETED");

setupCompletedGame(stack, multiGameA, playerIds);

setupCompletedGame(stack, multiGameB, playerIds);

const reportA = stack.auditEngine.buildAuditReport(multiGameA);

const reportB = stack.auditEngine.buildAuditReport(multiGameB);

assert(reportA.gameId === multiGameA, "first concurrent audit should match game A");

assert(reportB.gameId === multiGameB, "second concurrent audit should match game B");

const verifyAllResults = stack.auditEngine.verifyAll();

assert(
    verifyAllResults[validGameId]?.passed === true,
    "verifyAll should include valid completed game"
);

assert(
    verifyAllResults[multiGameA]?.passed === true
        && verifyAllResults[multiGameB]?.passed === true,
    "verifyAll should audit multiple games"
);

teardownCompletedGame(stack, validGameId, playerIds);

teardownCompletedGame(stack, multiGameA, playerIds);

teardownCompletedGame(stack, multiGameB, playerIds);

stack.shutdown();

console.log("AuditEngine tests passed");
