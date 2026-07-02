import { GameCatalog } from "../catalog/GameCatalog.js";
import { PAYMENT_STATUS } from "../catalog/PaymentRules.js";
import { loadProductionConfig } from "../config/production.js";
import {
    validateCatalogConsistency,
    validateStartupConfiguration
} from "../config/startupValidation.js";
import { EventBus } from "../events/EventBus.js";
import { AuditEngine } from "../engines/AuditEngine.js";
import { ConfigurationEngine } from "../engines/ConfigurationEngine.js";
import { GameClockEngine } from "../engines/GameClockEngine.js";
import { GameStateEngine } from "../engines/GameStateEngine.js";
import { GAME_STATES } from "../engines/gameState/GameStates.js";
import { PaymentEngine } from "../engines/PaymentEngine.js";
import { PhysicsEngine } from "../engines/PhysicsEngine.js";
import { RecoveryEngine } from "../engines/RecoveryEngine.js";
import { WinnerEngine } from "../engines/WinnerEngine.js";
import { InputAuthority } from "../input/InputAuthority.js";
import { PlayerManager } from "../managers/PlayerManager.js";
import { HealthService } from "../services/HealthService.js";
import { LoggerService } from "../services/LoggerService.js";
import { MetricsService } from "../services/MetricsService.js";
import { RandomService } from "../services/RandomService.js";
import { TelegramWalletAdapter } from "../services/telegram/TelegramWalletAdapter.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

const productionConfig = loadProductionConfig({
    NODE_ENV: "production",
    LOG_LEVEL: "warn"
});

assert(productionConfig.isProduction, "production config should detect production mode");

assert(
    productionConfig.runStartupDemonstrations === false,
    "startup demonstrations should be disabled in production"
);

assert(
    productionConfig.metricsEnabled === false,
    "metrics should be disabled in production by default"
);

const developmentConfig = loadProductionConfig({
    NODE_ENV: "development"
});

assert(
    developmentConfig.runStartupDemonstrations === true,
    "startup demonstrations should run in development"
);

validateStartupConfiguration({
    serverConfig: {
        port: 3001,
        host: "0.0.0.0",
        clientOrigin: "http://localhost:5173",
        nodeEnv: "development"
    },
    tonConfig: {
        network: "testnet",
        apiKey: ""
    },
    roomConfig: {
        maxPlayers: 3
    }
});

const catalog = new GameCatalog({ logger: new LoggerService() });

catalog.initialize();

validateCatalogConsistency(catalog);

const logger = new LoggerService({ logLevel: "warn" });

logger.initialize();

let infoSuppressed = true;

const originalWrite = process.stdout.write.bind(process.stdout);

process.stdout.write = (chunk) => {

    if (String(chunk).includes("suppressed-info-line")) {

        infoSuppressed = false;

    }

    return originalWrite(chunk);

};

logger.info("suppressed-info-line");

process.stdout.write = originalWrite;

assert(infoSuppressed, "info logs should be suppressed at warn level");

logger.startupLine("StartupProbe");

const metrics = new MetricsService({ enabled: true });

metrics.initialize();

metrics.record("startup.total", 12.5);

metrics.record("startup.total", 7.5);

const metricsSnapshot = metrics.getSnapshot();

assert(
    metricsSnapshot.metrics["startup.total"].count === 2,
    "metrics should aggregate repeated recordings"
);

const health = new HealthService({
    logger,
    productionConfig: developmentConfig
});

health.registerComponents({
    eventBus: true,
    physicsEngine: true
});

health.markStartupComplete(42);

const healthSnapshot = health.getHealthSnapshot();

assert(healthSnapshot.status === "ok", "health snapshot should report ok");

assert(
    healthSnapshot.startupDurationMs === 42,
    "health snapshot should include startup duration"
);

const eventBus = new EventBus({
    logger,
    eventBusConfig: { logEvents: false, showDebugPanel: false }
});

eventBus.initialize();

const randomService = new RandomService({ logger });

randomService.initialize();

randomService.setSeed(31);

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
    gameClock: gameClockEngine,
    metricsService: metrics
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
    telegramWalletAdapter: new TelegramWalletAdapter({ logger }),
    metricsService: metrics
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
    paymentEngine,
    metricsService: metrics
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
    recoveryEngine,
    metricsService: metrics
});

auditEngine.initialize();

const playerIds = [
    "stability-player-1",
    "stability-player-2",
    "stability-player-3"
];

function runCompletedGame(gameId) {

    configurationEngine.generateConfiguration(
        gameId,
        { roomId: `room-${gameId}`, stake: 10 },
        playerIds.map((playerId) => ({
            playerId,
            sectorCount: 2
        }))
    );

    gameStateEngine.initializeGameState(gameId);

    gameStateEngine.transition(gameId, GAME_STATES.COUNTDOWN, { reason: "test" });

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

    recoveryEngine.recoverSession(gameId);

    auditEngine.buildAuditReport(gameId);

}

function cleanupGame(gameId) {

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

runCompletedGame("stability-game-1");

runCompletedGame("stability-game-2");

assert(
    auditEngine.getAuditReport("stability-game-2") !== null,
    "second sequential game should produce an audit report"
);

cleanupGame("stability-game-1");

cleanupGame("stability-game-2");

assert(
    configurationEngine.listConfigurationIds().length === 0,
    "configuration registry should be empty after cleanup"
);

assert(
    auditEngine.getAuditReport("stability-game-1") === null,
    "audit reports should be removed during cleanup"
);

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

metrics.shutdown();

randomService.shutdown();

logger.shutdown();

console.log("Production stability tests passed");
