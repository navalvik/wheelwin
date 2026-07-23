import "dotenv/config";

import cors from "cors";
import express from "express";
import http from "http";

import { GameCatalog } from "./catalog/GameCatalog.js";
import { loadEventBusConfig } from "./config/events.js";
import { loadRoomConfig } from "./config/rooms.js";
import { loadServerConfig } from "./config/server.js";
import { loadSocketConfig } from "./config/socket.js";
import { loadTonConfig } from "./config/ton.js";
import { loadProductionConfig } from "./config/production.js";
import {
    validateEngineDependencies,
    validateStartupConfiguration
} from "./config/startupValidation.js";

import { LifecycleError } from "./errors/LifecycleError.js";

import { EventBus } from "./events/EventBus.js";
import { printEventBusDebugPanel } from "./events/EventBusDebugPanel.js";
import { EVENT_SOURCES } from "./events/EventSources.js";
import { EVENT_TYPES } from "./events/EventTypes.js";

import { AuditEngine } from "./engines/AuditEngine.js";
import { GameReportEngine } from "./engines/GameReportEngine.js";
import { ConfigurationEngine } from "./engines/ConfigurationEngine.js";
import { createStandardConfigurationPlayers } from "./engines/configuration/configurationPlayers.js";
import { GameClockEngine } from "./engines/GameClockEngine.js";
import { GameStateEngine } from "./engines/GameStateEngine.js";
import { PaymentEngine } from "./engines/PaymentEngine.js";
import { PhysicsEngine } from "./engines/PhysicsEngine.js";
import { RecoveryEngine } from "./engines/RecoveryEngine.js";
import { WinnerEngine } from "./engines/WinnerEngine.js";

import { GameManager } from "./managers/GameManager.js";
import { PlayerManager } from "./managers/PlayerManager.js";
import { RoomManager } from "./managers/RoomManager.js";

import { LoggerService } from "./services/LoggerService.js";
import { MetricsService } from "./services/MetricsService.js";
import { HealthService } from "./services/HealthService.js";
import { OperationalMetrics } from "./services/OperationalMetrics.js";
import { RandomService } from "./services/RandomService.js";
import { TimerService } from "./services/TimerService.js";
import { TonService } from "./services/TonService.js";

import { CONNECTION_STATE } from "./models/ConnectionState.js";
import { PLAYER_STATE } from "./models/PlayerState.js";

import { InputAuthority } from "./input/InputAuthority.js";

import { TelegramWalletAdapter } from "./services/telegram/TelegramWalletAdapter.js";

import { SocketGateway } from "./socket/SocketGateway.js";
import { GameplayContextResolver } from "./socket/GameplayContextResolver.js";
import { RoomLobbyBridge } from "./socket/RoomLobbyBridge.js";
import { SimulationLoop } from "./simulation/SimulationLoop.js";
import { GameplayPhaseLifecycle } from "./gameplay/GameplayPhaseLifecycle.js";
import { validateGameplayPhaseSequence } from "./gameplay/GameplayPhaseSequence.js";
import {
    buildGameplayPhaseTimers,
    loadGameplayPhaseConfig
} from "./config/gameplayPhases.js";
import { GameClockBroadcaster } from "./gameplay/GameClockBroadcaster.js";
import { ReadyPhaseBroadcaster } from "./gameplay/ReadyPhaseBroadcaster.js";
import { PreGameReadyActivation } from "./gameplay/PreGameReadyActivation.js";
import { SelfTestPhaseController } from "./gameplay/SelfTestPhaseController.js";
import { SpeedPhaseController } from "./gameplay/SpeedPhaseController.js";
import { BrakePhaseController } from "./gameplay/BrakePhaseController.js";
import { SpeedActivation } from "./gameplay/SpeedActivation.js";
import { OfflineInputContinuation } from "./gameplay/OfflineInputContinuation.js";
import { WinnerActivation } from "./gameplay/WinnerActivation.js";
import { ResultActivation } from "./gameplay/ResultActivation.js";
import { PaymentActivation } from "./gameplay/PaymentActivation.js";
import { AuditActivation } from "./gameplay/AuditActivation.js";
import { RecoverySnapshotCache } from "./gameplay/RecoverySnapshotCache.js";
import { GameplayLifecycle } from "./gameplay/GameplayLifecycle.js";
import { SetupSessionLifecycle } from "./gameplay/SetupSessionLifecycle.js";
import { ResultSessionLifecycle } from "./gameplay/ResultSessionLifecycle.js";
import { PaymentSessionManager } from "./gameplay/PaymentSessionManager.js";
import { GameContractManager } from "./gameplay/GameContractManager.js";
import { GameStartAuthorization } from "./gameplay/GameStartAuthorization.js";
import { GameContractDeployAdapter } from "./payment/GameContractDeployAdapter.js";
import { TonGameContractAdapter } from "./payment/TonGameContractAdapter.js";
import {
    BlockchainMonitor,
    EntryPaymentAuditLedger
} from "./payment/BlockchainMonitor.js";
import { SessionWalletStore } from "./session/SessionWalletStore.js";

class WheelWinApplication {
    constructor() {

        this._logger = null;

        this._serverConfig = null;

        this._productionConfig = null;

        this._metricsService = null;

        this._healthService = null;

        this._operationalMetrics = null;

        this._startupStartedAt = 0;

        this._httpServer = null;

        this._expressApp = null;

        this._services = null;

        this._managers = null;

        this._engines = null;

        this._socketGateway = null;

        this._eventBus = null;

        this._eventBusConfig = null;

        this._roomConfig = null;

        this._gameCatalog = null;

        this._inputAuthority = null;

        this._recoveryEngine = null;

        this._auditEngine = null;

        this._gameReportEngine = null;

        this._roomLobbyBridge = null;

        this._simulationLoop = null;

        this._gameplayPhaseLifecycle = null;

        this._readyPhaseBroadcaster = null;

        this._preGameReadyActivation = null;

        this._selfTestPhaseController = null;

        this._speedPhaseController = null;

        this._brakePhaseController = null;

        this._speedActivation = null;

        this._offlineInputContinuation = null;

        this._gameClockBroadcaster = null;

        this._winnerActivation = null;

        this._resultActivation = null;

        this._paymentActivation = null;

        this._auditActivation = null;

        this._recoverySnapshotCache = null;

        this._gameplayLifecycle = null;

        this._setupSessionLifecycle = null;

        this._resultSessionLifecycle = null;

        this._paymentSessionManager = null;

        this._gameContractManager = null;

        this._gameStartAuthorization = null;

        this._blockchainMonitor = null;

        this._entryPaymentAuditLedger = null;

        this._sessionWalletStore = null;

        this._tonConfig = null;

        this._isShuttingDown = false;

    }

    async start() {

        this._startupStartedAt = performance.now();

        this._serverConfig = loadServerConfig();

        this._productionConfig = loadProductionConfig(
            process.env,
            this._serverConfig
        );

        this._logger = new LoggerService({
            logLevel: this._productionConfig.logLevel
        });

        this._metricsService = new MetricsService({
            enabled: this._productionConfig.metricsEnabled
        });

        this._healthService = new HealthService({
            logger: this._logger,
            productionConfig: this._productionConfig
        });

        this._logger.info("WheelWin Server");
        this._logger.info("");
        this._logger.info("Initializing...");
        this._logger.info("");

        const socketConfig = loadSocketConfig(this._serverConfig);

        const tonConfig = loadTonConfig();

        this._tonConfig = tonConfig;

        this._eventBusConfig = loadEventBusConfig(
            process.env,
            this._serverConfig
        );

        this._roomConfig = loadRoomConfig();

        validateStartupConfiguration({
            serverConfig: this._serverConfig,
            tonConfig,
            roomConfig: this._roomConfig
        });

        this._services = this._createServices(tonConfig);

        this._initializeServices();

        this._metricsService.initialize();

        this._gameCatalog = new GameCatalog({
            logger: this._logger
        });

        this._gameCatalog.initialize();

        this._gameplayPhaseConfig = loadGameplayPhaseConfig();

        this._gameCatalog.configurePhaseTimers(
            buildGameplayPhaseTimers(this._gameplayPhaseConfig)
        );

        validateGameplayPhaseSequence();

        validateStartupConfiguration({
            serverConfig: this._serverConfig,
            tonConfig,
            roomConfig: this._roomConfig,
            gameCatalog: this._gameCatalog
        });

        this._logger.startupLine("GameCatalog");

        this._logGameCatalogSummary();

        this._eventBus = new EventBus({
            logger: this._logger,
            eventBusConfig: this._eventBusConfig
        });

        this._eventBus.initialize();

        this._logger.startupLine("EventBus");

        this._operationalMetrics = new OperationalMetrics({
            logger: this._logger,
            eventBus: this._eventBus,
            metricsService: this._metricsService,
            devMode: this._productionConfig.isDevelopment
        });

        this._operationalMetrics.initialize();

        this._logger.startupLine("OperationalMetrics");

        this._logger.connectEventBus(this._eventBus);

        this._eventBus.emit({
            source: EVENT_SOURCES.APPLICATION,
            type: EVENT_TYPES.CATALOG_LOADED,
            payload: {
                catalogVersion: this._gameCatalog.getCatalogVersion()
            }
        });

        this._managers = this._createManagers();

        this._initializeManagers();

        this._setupSessionLifecycle = new SetupSessionLifecycle({
            logger: this._logger,
            eventBus: this._eventBus,
            roomManager: this._managers.roomManager,
            roomConfig: this._roomConfig,
            devMode: this._productionConfig.isDevelopment
        });

        this._setupSessionLifecycle.initialize();

        this._managers.roomManager.attachSetupSessionLifecycle(
            this._setupSessionLifecycle
        );

        this._logger.startupLine("SetupSessionLifecycle");

        this._services.timerService.registerSetupSessionLifecycle(
            this._setupSessionLifecycle
        );

        this._resultSessionLifecycle = new ResultSessionLifecycle({
            logger: this._logger,
            eventBus: this._eventBus,
            roomConfig: this._roomConfig,
            devMode: this._productionConfig.isDevelopment
        });

        this._resultSessionLifecycle.initialize();

        this._logger.startupLine("ResultSessionLifecycle");

        this._services.timerService.registerResultSessionLifecycle(
            this._resultSessionLifecycle
        );

        this._engines = this._createEngines();

        this._initializeEngines();

        this._simulationLoop = new SimulationLoop({
            logger: this._logger,
            eventBus: this._eventBus,
            physicsEngine: this._engines.physicsEngine,
            // The loop's devMode only gates its per-tick trace logs. Bind it to an
            // explicit debug flag (not the broad development flag) so the loop no
            // longer floods stdout every tick; the flood could stall the event
            // loop and block the room-creation / lobby socket pipeline.
            devMode: this._productionConfig.debugSimulationLoop
        });

        this._simulationLoop.initialize();

        this._simulationLoop.start();

        this._logger.startupLine("SimulationLoop");

        this._gameplayPhaseLifecycle = new GameplayPhaseLifecycle({
            logger: this._logger,
            eventBus: this._eventBus,
            gameStateEngine: this._engines.gameStateEngine,
            gameClockEngine: this._engines.gameClockEngine,
            winnerEngine: this._engines.winnerEngine,
            devMode: this._productionConfig.isDevelopment
        });

        this._gameplayPhaseLifecycle.initialize();

        this._logger.startupLine("GameplayPhaseLifecycle");

        this._readyPhaseBroadcaster = new ReadyPhaseBroadcaster({
            logger: this._logger,
            eventBus: this._eventBus,
            configurationEngine: this._engines.configurationEngine,
            physicsEngine: this._engines.physicsEngine,
            devMode: this._productionConfig.isDevelopment
        });

        this._readyPhaseBroadcaster.initialize();

        this._logger.startupLine("ReadyPhaseBroadcaster");

        this._preGameReadyActivation = new PreGameReadyActivation({
            logger: this._logger,
            eventBus: this._eventBus,
            configurationEngine: this._engines.configurationEngine,
            gameStateEngine: this._engines.gameStateEngine,
            gameClockEngine: this._engines.gameClockEngine,
            physicsEngine: this._engines.physicsEngine,
            devMode: this._productionConfig.isDevelopment
        });

        this._preGameReadyActivation.initialize();

        this._logger.startupLine("PreGameReadyActivation");

        this._selfTestPhaseController = new SelfTestPhaseController({
            logger: this._logger,
            eventBus: this._eventBus,
            configurationEngine: this._engines.configurationEngine,
            physicsEngine: this._engines.physicsEngine,
            gameClockEngine: this._engines.gameClockEngine,
            devMode: this._productionConfig.isDevelopment
        });

        this._selfTestPhaseController.initialize();

        this._logger.startupLine("SelfTestPhaseController");

        this._speedActivation = new SpeedActivation({
            logger: this._logger,
            eventBus: this._eventBus,
            gameClockEngine: this._engines.gameClockEngine,
            gameStateEngine: this._engines.gameStateEngine,
            devMode: this._productionConfig.isDevelopment
        });

        this._speedActivation.initialize();

        this._logger.startupLine("SpeedActivation");

        this._gameClockBroadcaster = new GameClockBroadcaster({
            logger: this._logger,
            eventBus: this._eventBus,
            gameClockEngine: this._engines.gameClockEngine,
            devMode: this._productionConfig.isDevelopment
        });

        this._gameClockBroadcaster.initialize();

        this._logger.startupLine("GameClockBroadcaster");

        this._winnerActivation = new WinnerActivation({
            logger: this._logger,
            eventBus: this._eventBus,
            physicsEngine: this._engines.physicsEngine,
            winnerEngine: this._engines.winnerEngine,
            gameStateEngine: this._engines.gameStateEngine,
            devMode: this._productionConfig.isDevelopment
        });

        this._winnerActivation.initialize();

        this._logger.startupLine("WinnerActivation");

        this._resultActivation = new ResultActivation({
            logger: this._logger,
            eventBus: this._eventBus,
            gameClockEngine: this._engines.gameClockEngine,
            winnerEngine: this._engines.winnerEngine,
            devMode: this._productionConfig.isDevelopment
        });

        this._resultActivation.initialize();

        this._logger.startupLine("ResultActivation");

        this._paymentActivation = new PaymentActivation({
            logger: this._logger,
            eventBus: this._eventBus,
            paymentEngine: this._engines.paymentEngine,
            devMode: this._productionConfig.isDevelopment
        });

        this._paymentActivation.initialize();

        this._logger.startupLine("PaymentActivation");

        this._gameplayLifecycle = new GameplayLifecycle({
            logger: this._logger,
            eventBus: this._eventBus,
            gameCatalog: this._gameCatalog,
            physicsEngine: this._engines.physicsEngine,
            inputAuthority: this._inputAuthority,
            gameClockEngine: this._engines.gameClockEngine,
            gameStateEngine: this._engines.gameStateEngine,
            configurationEngine: this._engines.configurationEngine,
            winnerEngine: this._engines.winnerEngine,
            winnerActivation: this._winnerActivation,
            resultActivation: this._resultActivation,
            speedActivation: this._speedActivation,
            paymentEngine: this._engines.paymentEngine,
            paymentActivation: this._paymentActivation,
            gameManager: this._managers.gameManager,
            devMode: this._productionConfig.isDevelopment
        });

        this._gameplayLifecycle.initialize();

        this._logger.startupLine("GameplayLifecycle");

        this._inputAuthority = new InputAuthority({
            logger: this._logger,
            eventBus: this._eventBus,
            gameCatalog: this._gameCatalog,
            playerManager: this._managers.playerManager,
            physicsEngine: this._engines.physicsEngine,
            gameStateEngine: this._engines.gameStateEngine,
            devMode: this._productionConfig.isDevelopment
        });

        this._inputAuthority.initialize();

        this._simulationLoop.setInputAuthority(this._inputAuthority);

        // GameplayLifecycle is constructed before InputAuthority exists, so it
        // captured a null reference. Inject the real instance now (same pattern as
        // SimulationLoop above) so deferred teardown never runs against null.
        this._gameplayLifecycle.setInputAuthority(this._inputAuthority);

        this._logger.startupLine("InputAuthority");

        this._speedPhaseController = new SpeedPhaseController({
            logger: this._logger,
            eventBus: this._eventBus,
            physicsEngine: this._engines.physicsEngine,
            inputAuthority: this._inputAuthority,
            devMode: this._productionConfig.isDevelopment
        });

        this._speedPhaseController.initialize();

        this._logger.startupLine("SpeedPhaseController");

        this._brakePhaseController = new BrakePhaseController({
            logger: this._logger,
            eventBus: this._eventBus,
            physicsEngine: this._engines.physicsEngine,
            gameClockEngine: this._engines.gameClockEngine,
            devMode: this._productionConfig.isDevelopment
        });

        this._brakePhaseController.initialize();

        this._logger.startupLine("BrakePhaseController");

        // C4.8b — Authoritative continuation of offline players' remaining SPEED
        // input. Constructed after InputAuthority (it drives InputAuthority's
        // authoritative input path) and injected into GameplayLifecycle so its
        // per-game cursors are released during teardown.
        this._offlineInputContinuation = new OfflineInputContinuation({
            logger: this._logger,
            eventBus: this._eventBus,
            inputAuthority: this._inputAuthority,
            gameStateEngine: this._engines.gameStateEngine,
            playerManager: this._managers.playerManager,
            gameCatalog: this._gameCatalog,
            devMode: this._productionConfig.isDevelopment
        });

        this._offlineInputContinuation.initialize();

        this._gameplayLifecycle.setOfflineInputContinuation(
            this._offlineInputContinuation
        );

        this._logger.startupLine("OfflineInputContinuation");

        // C5.6C — GameManager SETUP_SESSION_COMPLETED subscription is deferred
        // until RoomLobbyBridge has registered, so soft-disconnect protection
        // (_startedRooms) is armed before READY fires during bootstrap.

        this._recoveryEngine = new RecoveryEngine({
            logger: this._logger,
            eventBus: this._eventBus,
            gameCatalog: this._gameCatalog,
            configurationEngine: this._engines.configurationEngine,
            gameStateEngine: this._engines.gameStateEngine,
            gameClock: this._engines.gameClockEngine,
            physicsEngine: this._engines.physicsEngine,
            inputAuthority: this._inputAuthority,
            winnerEngine: this._engines.winnerEngine,
            paymentEngine: this._engines.paymentEngine,
            resultActivation: this._resultActivation,
            preGameReadyActivation: this._preGameReadyActivation,
            metricsService: this._metricsService
        });

        this._recoveryEngine.initialize();

        this._logger.startupLine("RecoveryEngine");

        this._auditEngine = new AuditEngine({
            logger: this._logger,
            eventBus: this._eventBus,
            gameCatalog: this._gameCatalog,
            configurationEngine: this._engines.configurationEngine,
            gameStateEngine: this._engines.gameStateEngine,
            gameClock: this._engines.gameClockEngine,
            physicsEngine: this._engines.physicsEngine,
            inputAuthority: this._inputAuthority,
            winnerEngine: this._engines.winnerEngine,
            paymentEngine: this._engines.paymentEngine,
            recoveryEngine: this._recoveryEngine,
            metricsService: this._metricsService
        });

        this._auditEngine.initialize();

        this._logger.startupLine("AuditEngine");

        this._sessionWalletStore = new SessionWalletStore();

        this._gameReportEngine = new GameReportEngine({
            logger: this._logger,
            gameCatalog: this._gameCatalog,
            playerManager: this._managers.playerManager,
            sessionWalletStore: this._sessionWalletStore,
            serverVersion: "1.0.0"
        });

        this._gameReportEngine.initialize();

        this._logger.startupLine("GameReportEngine");

        this._auditActivation = new AuditActivation({
            logger: this._logger,
            eventBus: this._eventBus,
            auditEngine: this._auditEngine,
            gameReportEngine: this._gameReportEngine,
            devMode: this._productionConfig.isDevelopment
        });

        this._auditActivation.initialize();

        this._logger.startupLine("AuditActivation");

        // C4.4 — Make audit the final authoritative step: teardown now waits for
        // audit to reach a terminal state before destroying gameplay data.
        this._gameplayLifecycle.configureAudit({
            auditEngine: this._auditEngine,
            auditActivation: this._auditActivation
        });

        this._recoverySnapshotCache = new RecoverySnapshotCache({
            logger: this._logger,
            eventBus: this._eventBus,
            recoveryEngine: this._recoveryEngine,
            paymentEngine: this._engines.paymentEngine,
            auditEngine: this._auditEngine,
            devMode: this._productionConfig.isDevelopment
        });

        this._recoverySnapshotCache.initialize();

        this._logger.startupLine("RecoverySnapshotCache");

        validateEngineDependencies({
            logger: this._logger,
            eventBus: this._eventBus,
            gameCatalog: this._gameCatalog,
            configurationEngine: this._engines.configurationEngine,
            gameStateEngine: this._engines.gameStateEngine,
            gameClockEngine: this._engines.gameClockEngine,
            physicsEngine: this._engines.physicsEngine,
            winnerEngine: this._engines.winnerEngine,
            paymentEngine: this._engines.paymentEngine,
            inputAuthority: this._inputAuthority,
            recoveryEngine: this._recoveryEngine,
            auditEngine: this._auditEngine
        });

        this._healthService.registerComponents({
            logger: true,
            gameCatalog: Boolean(this._gameCatalog),
            eventBus: Boolean(this._eventBus),
            gameManager: Boolean(this._managers?.gameManager),
            roomManager: Boolean(this._managers?.roomManager),
            playerManager: Boolean(this._managers?.playerManager),
            configurationEngine: Boolean(this._engines?.configurationEngine),
            gameStateEngine: Boolean(this._engines?.gameStateEngine),
            gameClockEngine: Boolean(this._engines?.gameClockEngine),
            physicsEngine: Boolean(this._engines?.physicsEngine),
            simulationLoop: Boolean(this._simulationLoop),
            gameplayPhaseLifecycle: Boolean(this._gameplayPhaseLifecycle),
            readyPhaseBroadcaster: Boolean(this._readyPhaseBroadcaster),
            preGameReadyActivation: Boolean(this._preGameReadyActivation),
            selfTestPhaseController: Boolean(this._selfTestPhaseController),
            speedPhaseController: Boolean(this._speedPhaseController),
            brakePhaseController: Boolean(this._brakePhaseController),
            speedActivation: Boolean(this._speedActivation),
            offlineInputContinuation: Boolean(this._offlineInputContinuation),
            gameClockBroadcaster: Boolean(this._gameClockBroadcaster),
            winnerActivation: Boolean(this._winnerActivation),
            resultActivation: Boolean(this._resultActivation),
            paymentActivation: Boolean(this._paymentActivation),
            auditActivation: Boolean(this._auditActivation),
            gameplayLifecycle: Boolean(this._gameplayLifecycle),
            setupSessionLifecycle: Boolean(this._setupSessionLifecycle),
            winnerEngine: Boolean(this._engines?.winnerEngine),
            paymentEngine: Boolean(this._engines?.paymentEngine),
            inputAuthority: Boolean(this._inputAuthority),
            recoveryEngine: Boolean(this._recoveryEngine),
            recoverySnapshotCache: Boolean(this._recoverySnapshotCache),
            auditEngine: Boolean(this._auditEngine),
            socketGateway: false
        });

        this._expressApp = this._createExpressApp();

        this._httpServer = http.createServer(this._expressApp);

        this._gameplayContextResolver = new GameplayContextResolver({
            logger: this._logger,
            playerManager: this._managers.playerManager,
            roomManager: this._managers.roomManager
        });

        this._managers.gameManager.linkGameplayContextResolver(
            this._gameplayContextResolver
        );

        this._entryPaymentAuditLedger = new EntryPaymentAuditLedger();

        this._blockchainMonitor = new BlockchainMonitor({
            logger: this._logger,
            eventBus: this._eventBus,
            transport: this._services.tonService.getTransport(),
            auditLedger: this._entryPaymentAuditLedger,
            pollIntervalMs: this._tonConfig.pollIntervalMs
        });

        this._blockchainMonitor.initialize();

        this._logger.startupLine("BlockchainMonitor");

        this._paymentSessionManager = new PaymentSessionManager({
            logger: this._logger,
            eventBus: this._eventBus,
            playerManager: this._managers.playerManager,
            roomManager: this._managers.roomManager,
            roomConfig: this._roomConfig,
            gameplayContextResolver: this._gameplayContextResolver,
            sessionWalletStore: this._sessionWalletStore,
            blockchainMonitor: this._blockchainMonitor,
            devMode: this._productionConfig.isDevelopment
        });

        this._paymentSessionManager.initialize();

        this._logger.startupLine("PaymentSessionManager");

        this._services.timerService.registerPaymentSessionManager(
            this._paymentSessionManager
        );

        const deployAdapter = this._tonConfig.deployMode === "stub"
            ? new GameContractDeployAdapter({
                logger: this._logger,
                deployDelayMs: this._productionConfig.isDevelopment ? 40 : 0
            })
            : new TonGameContractAdapter({
                logger: this._logger,
                tonConfig: this._tonConfig,
                transport: this._services.tonService.getTransport(),
                tonClient: this._services.tonService.getClient()
            });

        this._gameContractManager = new GameContractManager({
            logger: this._logger,
            eventBus: this._eventBus,
            playerManager: this._managers.playerManager,
            roomManager: this._managers.roomManager,
            sessionWalletStore: this._sessionWalletStore,
            configurationEngine: this._engines.configurationEngine,
            deployAdapter,
            creatingDelayMs: this._productionConfig.isDevelopment ? 40 : 0,
            devMode: this._productionConfig.isDevelopment
        });

        this._gameContractManager.initialize();

        this._logger.startupLine("GameContractManager");

        this._gameStartAuthorization = new GameStartAuthorization({
            logger: this._logger,
            eventBus: this._eventBus,
            roomManager: this._managers.roomManager,
            playerManager: this._managers.playerManager,
            gameManager: this._managers.gameManager,
            paymentSessionManager: this._paymentSessionManager,
            gameContractManager: this._gameContractManager,
            configurationEngine: this._engines.configurationEngine,
            physicsEngine: this._engines.physicsEngine,
            gameClockEngine: this._engines.gameClockEngine,
            gameplayContextResolver: this._gameplayContextResolver,
            recoveryEngine: this._recoveryEngine,
            auditLedger: this._entryPaymentAuditLedger,
            roomConfig: this._roomConfig,
            devMode: this._productionConfig.isDevelopment
        });

        this._gameStartAuthorization.initialize();

        this._logger.startupLine("GameStartAuthorization");

        this._socketGateway = new SocketGateway({
            logger: this._logger,
            socketConfig,
            eventBus: this._eventBus,
            inputAuthority: this._inputAuthority,
            gameplayContextResolver: this._gameplayContextResolver,
            devMode: this._productionConfig.isDevelopment
        });

        this._socketGateway.initialize(this._httpServer);

        this._socketGateway.connectEventBus(this._eventBus);

        this._roomLobbyBridge = new RoomLobbyBridge({
            logger: this._logger,
            eventBus: this._eventBus,
            roomManager: this._managers.roomManager,
            playerManager: this._managers.playerManager,
            gameplayContextResolver: this._gameplayContextResolver,
            setupSessionLifecycle: this._setupSessionLifecycle,
            resultSessionLifecycle: this._resultSessionLifecycle,
            paymentSessionManager: this._paymentSessionManager,
            gameContractManager: this._gameContractManager,
            gameStartAuthorization: this._gameStartAuthorization,
            sessionWalletStore: this._sessionWalletStore,
            isDevelopment: this._productionConfig.isDevelopment
        });

        this._roomLobbyBridge.initialize();

        this._managers.gameManager.configureGameplayBootstrap({
            roomManager: this._managers.roomManager,
            playerManager: this._managers.playerManager,
            configurationEngine: this._engines.configurationEngine,
            gameStateEngine: this._engines.gameStateEngine,
            inputAuthority: this._inputAuthority,
            physicsEngine: this._engines.physicsEngine,
            gameClockEngine: this._engines.gameClockEngine,
            gameCatalog: this._gameCatalog,
            gameplayContextResolver: this._gameplayContextResolver,
            devMode: this._productionConfig.isDevelopment
        });

        this._socketGateway.configurePreGameReady({
            preGameReadyActivation: this._preGameReadyActivation
        });

        this._socketGateway.configureRecovery({
            recoveryEngine: this._recoveryEngine,
            recoverySnapshotCache: this._recoverySnapshotCache,
            paymentEngine: this._engines.paymentEngine,
            auditEngine: this._auditEngine,
            roomLobbyBridge: this._roomLobbyBridge
        });

        this._logger.startupLine("RoomLobbyBridge");

        this._logger.startupLine("SocketGateway");

        this._healthService.registerComponents({
            logger: true,
            gameCatalog: Boolean(this._gameCatalog),
            eventBus: Boolean(this._eventBus),
            gameManager: Boolean(this._managers?.gameManager),
            roomManager: Boolean(this._managers?.roomManager),
            playerManager: Boolean(this._managers?.playerManager),
            configurationEngine: Boolean(this._engines?.configurationEngine),
            gameStateEngine: Boolean(this._engines?.gameStateEngine),
            gameClockEngine: Boolean(this._engines?.gameClockEngine),
            physicsEngine: Boolean(this._engines?.physicsEngine),
            simulationLoop: Boolean(this._simulationLoop),
            gameplayPhaseLifecycle: Boolean(this._gameplayPhaseLifecycle),
            readyPhaseBroadcaster: Boolean(this._readyPhaseBroadcaster),
            preGameReadyActivation: Boolean(this._preGameReadyActivation),
            selfTestPhaseController: Boolean(this._selfTestPhaseController),
            speedPhaseController: Boolean(this._speedPhaseController),
            brakePhaseController: Boolean(this._brakePhaseController),
            speedActivation: Boolean(this._speedActivation),
            offlineInputContinuation: Boolean(this._offlineInputContinuation),
            gameClockBroadcaster: Boolean(this._gameClockBroadcaster),
            winnerActivation: Boolean(this._winnerActivation),
            resultActivation: Boolean(this._resultActivation),
            paymentActivation: Boolean(this._paymentActivation),
            auditActivation: Boolean(this._auditActivation),
            gameplayLifecycle: Boolean(this._gameplayLifecycle),
            setupSessionLifecycle: Boolean(this._setupSessionLifecycle),
            paymentSessionManager: Boolean(this._paymentSessionManager),
            gameContractManager: Boolean(this._gameContractManager),
            winnerEngine: Boolean(this._engines?.winnerEngine),
            paymentEngine: Boolean(this._engines?.paymentEngine),
            inputAuthority: Boolean(this._inputAuthority),
            recoveryEngine: Boolean(this._recoveryEngine),
            recoverySnapshotCache: Boolean(this._recoverySnapshotCache),
            auditEngine: Boolean(this._auditEngine),
            roomLobbyBridge: Boolean(this._roomLobbyBridge),
            socketGateway: Boolean(this._socketGateway),
            operationalMetrics: Boolean(this._operationalMetrics)
        });

        // C4.5 — expose live runtime counts through the existing HealthService.
        this._healthService.registerRuntimeProvider(() => this._collectRuntime());

        await this._listen();

        const startupDurationMs = performance.now() - this._startupStartedAt;

        this._metricsService.record("startup.total", startupDurationMs);

        this._healthService.markStartupComplete(
            Number(startupDurationMs.toFixed(3))
        );

        const healthSnapshot = this._healthService.getHealthSnapshot();

        this._healthService.logStartupSummary(healthSnapshot);

        this._logger.info("");
        this._logger.info("Server Ready");
        this._logger.info("");

        if (this._productionConfig.runStartupDemonstrations) {

            this._runStartupDemonstrations();

        }

        this._registerShutdownHandlers();

    }

    async shutdown() {

        if (this._isShuttingDown) {

            return;

        }

        this._isShuttingDown = true;

        this._healthService.markShuttingDown();

        this._logger.info("");
        this._logger.info("Stopping WheelWin Server...");
        this._logger.info("");

        if (this._eventBus) {

            this._eventBus.emit({
                source: EVENT_SOURCES.APPLICATION,
                type: EVENT_TYPES.SERVER_SHUTDOWN,
                payload: {
                    reason: "application_shutdown"
                }
            });

        }

        await this._safeShutdownStep("httpServer", () => this._closeHttpServer());

        this._safeShutdownStep("roomLobbyBridge", () => {

            if (this._roomLobbyBridge) {

                this._roomLobbyBridge.shutdown();

            }

        });

        this._safeShutdownStep("setupSessionLifecycle", () => {

            if (this._setupSessionLifecycle) {

                this._setupSessionLifecycle.shutdown();

            }

        });

        this._safeShutdownStep("resultSessionLifecycle", () => {

            if (this._resultSessionLifecycle) {

                this._resultSessionLifecycle.shutdown();

            }

        });

        this._safeShutdownStep("paymentSessionManager", () => {

            if (this._paymentSessionManager) {

                this._paymentSessionManager.shutdown();

            }

        });

        this._safeShutdownStep("blockchainMonitor", () => {

            if (this._blockchainMonitor) {

                this._blockchainMonitor.shutdown();

            }

        });

        this._safeShutdownStep("gameContractManager", () => {

            if (this._gameContractManager) {

                this._gameContractManager.shutdown();

            }

        });

        this._safeShutdownStep("gameStartAuthorization", () => {

            if (this._gameStartAuthorization) {

                this._gameStartAuthorization.shutdown();

            }

        });

        await this._safeShutdownStep("socketGateway", async () => {

            if (this._socketGateway) {

                await this._socketGateway.shutdown();

            }

        });

        this._safeShutdownStep("gameplayLifecycle", () => {

            if (this._gameplayLifecycle) {

                this._gameplayLifecycle.shutdown();

            }

        });

        this._safeShutdownStep("paymentActivation", () => {

            if (this._paymentActivation) {

                this._paymentActivation.shutdown();

            }

        });

        this._safeShutdownStep("resultActivation", () => {

            if (this._resultActivation) {

                this._resultActivation.shutdown();

            }

        });

        this._safeShutdownStep("winnerActivation", () => {

            if (this._winnerActivation) {

                this._winnerActivation.shutdown();

            }

        });

        this._safeShutdownStep("gameClockBroadcaster", () => {

            if (this._gameClockBroadcaster) {

                this._gameClockBroadcaster.shutdown();

            }

        });

        this._safeShutdownStep("speedActivation", () => {

            if (this._speedActivation) {

                this._speedActivation.shutdown();

            }

        });

        this._safeShutdownStep("offlineInputContinuation", () => {

            if (this._offlineInputContinuation) {

                this._offlineInputContinuation.shutdown();

            }

        });

        this._safeShutdownStep("readyPhaseBroadcaster", () => {

            if (this._readyPhaseBroadcaster) {

                this._readyPhaseBroadcaster.shutdown();

            }

        });

        this._safeShutdownStep("preGameReadyActivation", () => {

            if (this._preGameReadyActivation) {

                this._preGameReadyActivation.shutdown();

            }

        });

        this._safeShutdownStep("selfTestPhaseController", () => {

            if (this._selfTestPhaseController) {

                this._selfTestPhaseController.shutdown();

            }

        });

        this._safeShutdownStep("speedPhaseController", () => {

            if (this._speedPhaseController) {

                this._speedPhaseController.shutdown();

            }

        });

        this._safeShutdownStep("brakePhaseController", () => {

            if (this._brakePhaseController) {

                this._brakePhaseController.shutdown();

            }

        });

        this._safeShutdownStep("gameplayPhaseLifecycle", () => {

            if (this._gameplayPhaseLifecycle) {

                this._gameplayPhaseLifecycle.shutdown();

            }

        });

        this._safeShutdownStep("simulationLoop", () => {

            if (this._simulationLoop) {

                this._simulationLoop.shutdown();

            }

        });

        this._safeShutdownStep("engines", () => {

            this._shutdownEngines();

        });

        this._safeShutdownStep("inputAuthority", () => {

            if (this._inputAuthority) {

                this._inputAuthority.shutdown();

            }

        });

        this._safeShutdownStep("recoverySnapshotCache", () => {

            if (this._recoverySnapshotCache) {

                this._recoverySnapshotCache.shutdown();

            }

        });

        this._safeShutdownStep("recoveryEngine", () => {

            if (this._recoveryEngine) {

                this._recoveryEngine.shutdown();

            }

        });

        this._safeShutdownStep("auditActivation", () => {

            if (this._auditActivation) {

                this._auditActivation.shutdown();

            }

        });

        this._safeShutdownStep("auditEngine", () => {

            if (this._auditEngine) {

                this._auditEngine.shutdown();

            }

        });

        this._safeShutdownStep("gameReportEngine", () => {

            if (this._gameReportEngine) {

                this._gameReportEngine.shutdown();

            }

        });

        this._safeShutdownStep("managers", () => {

            this._shutdownManagers();

        });

        this._safeShutdownStep("operationalMetrics", () => {

            if (this._operationalMetrics) {

                this._operationalMetrics.shutdown();

            }

        });

        this._safeShutdownStep("eventBus", () => {

            this._shutdownEventBus();

        });

        this._safeShutdownStep("services", () => {

            this._shutdownServices();

        });

        this._logger.info("");
        this._logger.info("Shutdown complete.");
        this._logger.info("");

    }

    /**
     * C4.5 — Live runtime counts pulled from existing engine/service accessors.
     * Read-only: it never mutates state and is safe to call on every /health hit.
     */
    _collectRuntime() {

        return {
            activeRooms: this._managers?.roomManager?.getRooms?.().length ?? 0,
            activeGames: this._managers?.gameManager?.getGames?.().length ?? 0,
            activeSimulations:
                this._engines?.physicsEngine?.getActiveSimulationCount?.() ?? 0,
            activeTimers:
                this._engines?.gameClockEngine?.getActiveClockCount?.() ?? 0,
            activeSockets:
                this._socketGateway?.getConnectedSocketCount?.() ?? 0,
            pendingTeardowns:
                this._gameplayLifecycle?.getPendingTeardownCount?.() ?? 0,
            pendingPayments:
                this._engines?.paymentEngine?.getActivePaymentCount?.() ?? 0,
            pendingAudits:
                this._auditEngine?.getActiveAuditCount?.() ?? 0
        };

    }

    _createServices(tonConfig) {

        const timerService = new TimerService({ logger: this._logger });

        const randomService = new RandomService({ logger: this._logger });

        const tonService = new TonService({
            logger: this._logger,
            tonConfig
        });

        return {
            timerService,
            randomService,
            tonService
        };

    }

    _initializeServices() {

        this._logger.initialize();

        this._logger.startupLine("LoggerService");

        this._services.timerService.initialize();

        this._logger.startupLine("TimerService");

        this._services.randomService.initialize();

        this._logger.startupLine("RandomService");

        this._logRandomServiceSummary();

        this._services.tonService.initialize();

        this._logger.startupLine("TonService");

    }

    _runGameManagerDemonstration() {

        const { gameManager } = this._managers;

        const game = gameManager.createGame("demo-room");

        if (!game) {

            return;

        }

        gameManager.initializeGame(game.gameId);

        gameManager.startGame(game.gameId);

        gameManager.finishGame(game.gameId);

        gameManager.destroyGame(game.gameId);

        this._logger.info("");

    }

    _runRoomManagerDemonstration() {

        const { roomManager } = this._managers;

        const room = roomManager.createRoom();

        if (!room) {

            return;

        }

        for (let index = 0; index < room.maxPlayers; index += 1) {

            roomManager.addPlayer(room.roomId, `demo-slot-${index + 1}`);

        }

        roomManager.lockRoom(room.roomId);

        roomManager.destroyRoom(room.roomId);

        this._logger.info("");

    }

    _runPlayerManagerDemonstration() {

        const { playerManager } = this._managers;

        const player = playerManager.createPlayer({
            nickname: "Demo Player",
            wallet: null,
            icon: "default"
        });

        if (!player) {

            return;

        }

        const { playerId } = player.identity;

        playerManager.setConnectionState(
            playerId,
            CONNECTION_STATE.CONNECTED
        );

        playerManager.setPlayerState(playerId, PLAYER_STATE.IN_ROOM);

        playerManager.setConnectionState(
            playerId,
            CONNECTION_STATE.DISCONNECTED
        );

        playerManager.removePlayer(playerId);

        this._logger.info("");

    }

    _logRandomServiceSummary() {

        if (this._serverConfig.nodeEnv !== "development") {

            return;

        }

        const snapshot = this._services.randomService.getDebugSnapshot();

        this._logger.info(`Mode: ${snapshot.mode}`);
        this._logger.info(`Seed: ${snapshot.seed ?? "None"}`);
        this._logger.info("");

    }

    _logGameCatalogSummary() {

        if (this._serverConfig.nodeEnv !== "development") {

            return;

        }

        const catalog = this._gameCatalog;

        this._logger.info("Game Catalog Loaded");
        this._logger.info(`Colors: ${catalog.getColors().length}`);
        this._logger.info(`Icons: ${catalog.getIcons().length}`);
        this._logger.info(`Stakes: ${catalog.getStakes().length}`);
        this._logger.info("Wheel Rules Loaded");
        this._logger.info("Timers Loaded");
        this._logger.info(`Catalog Version: ${catalog.getCatalogVersion()}`);
        this._logger.info("");

    }

    _runConfigurationEngineDemonstration() {

        const { gameManager } = this._managers;

        const { configurationEngine } = this._engines;

        const game = gameManager.createGame("config-demo-room");

        if (!game) {

            return;

        }

        try {

            configurationEngine.generateConfiguration(
                game.gameId,
                {
                    roomId: "config-demo-room",
                    stake: 1
                },
                createStandardConfigurationPlayers([
                    "demo-player-1",
                    "demo-player-2",
                    "demo-player-3"
                ])
            );

        } finally {

            configurationEngine.removeConfiguration(game.gameId);

            gameManager.destroyGame(game.gameId);

        }

        this._logger.info("");

    }

    _runGameStateEngineDemonstration() {

        const { gameStateEngine } = this._engines;

        const gameId = "fsm-demo-game";

        gameStateEngine.initializeGameState(gameId);

        gameStateEngine.transition(gameId, "COUNTDOWN", {
            reason: "Countdown completed"
        });

        gameStateEngine.transition(gameId, "SELF_TEST", {
            reason: "Self-test passed"
        });

        gameStateEngine.transition(gameId, "SPEED", {
            reason: "Speed phase finished"
        });

        gameStateEngine.transition(gameId, "BRAKE", {
            reason: "Brake completed"
        });

        gameStateEngine.transition(gameId, "RESULT", {
            reason: "Result reached"
        });

        gameStateEngine.transition(gameId, "READY", {
            reason: "Invalid transition attempt"
        });

        gameStateEngine.removeState(gameId);

        this._logger.info("");

    }

    _runGameClockEngineDemonstration() {

        this._runGameClockEngineDemonstrationAsync().catch((error) => {

            this._logger.error("Game clock demonstration failed", error);

        });

    }

    async _runGameClockEngineDemonstrationAsync() {

        const { gameClockEngine } = this._engines;

        const gameId = "clock-demo-game";

        const waitForPhaseTimeout = (phase) => new Promise((resolve) => {

            const handler = (envelope) => {

                if (envelope.payload.gameId !== gameId) {

                    return;

                }

                if (envelope.payload.phase !== phase) {

                    return;

                }

                this._eventBus.unsubscribe(EVENT_TYPES.PHASE_TIMEOUT, handler);

                resolve();

            };

            this._eventBus.subscribe(EVENT_TYPES.PHASE_TIMEOUT, handler);

        });

        gameClockEngine.createClock(gameId);

        gameClockEngine.startClock(gameId);

        await waitForPhaseTimeout("COUNTDOWN");

        await waitForPhaseTimeout("SELF_TEST");

        gameClockEngine.pauseClock(gameId);

        gameClockEngine.resumeClock(gameId);

        gameClockEngine.completePhase(gameId);

        await waitForPhaseTimeout("BRAKE");

        gameClockEngine.stopClock(gameId);

        gameClockEngine.removeClock(gameId);

        this._logger.info("");

    }

    _runPhysicsEngineDemonstration() {

        const { physicsEngine } = this._engines;

        const gameId = "physics-demo-game";

        physicsEngine.createSimulation(gameId);

        physicsEngine.startSimulation(gameId);

        physicsEngine.applyAcceleration(gameId, Math.PI * 2);

        physicsEngine.updateSimulation(gameId, 35);

        physicsEngine.applyBrake(gameId);

        let snapshot = physicsEngine.getSimulation(gameId);

        while (snapshot?.runtime.state === "BRAKING") {

            physicsEngine.updateSimulation(gameId, 20);

            snapshot = physicsEngine.getSimulation(gameId);

        }

        physicsEngine.removeSimulation(gameId);

        this._logger.info("");

    }

    _runInputAuthorityDemonstration() {

        this._runInputAuthorityDemonstrationAsync().catch((error) => {

            this._logger.error("Input authority demonstration failed", error);

        });

    }

    async _runInputAuthorityDemonstrationAsync() {

        const { playerManager } = this._managers;

        const { gameStateEngine, physicsEngine } = this._engines;

        const { inputAuthority } = this;

        const gameId = "input-demo-game";

        const player = playerManager.createPlayer({
            nickname: "Input Demo",
            icon: "dice"
        });

        if (!player) {

            return;

        }

        const playerId = player.identity.playerId;

        playerManager.setPlayerState(playerId, PLAYER_STATE.PLAYING);

        gameStateEngine.initializeGameState(gameId);

        gameStateEngine.transition(gameId, "COUNTDOWN", { reason: "demo" });

        gameStateEngine.transition(gameId, "SELF_TEST", { reason: "demo" });

        gameStateEngine.transition(gameId, "SPEED", { reason: "demo" });

        physicsEngine.createSimulation(gameId);

        physicsEngine.startSimulation(gameId);

        inputAuthority.registerPlayer(gameId, playerId);

        for (let cycle = 0; cycle < 3; cycle += 1) {

            inputAuthority.handleButtonPress(gameId, playerId);

            inputAuthority.handleButtonRelease(gameId, playerId);

            if (cycle < 2) {

                await new Promise((resolve) => {

                    setTimeout(resolve, 600);

                });

            }

        }

        inputAuthority.handleButtonPress(gameId, playerId);

        inputAuthority.removePlayer(gameId, playerId);

        physicsEngine.removeSimulation(gameId);

        gameStateEngine.removeState(gameId);

        playerManager.removePlayer(playerId);

        this._logger.info("");

    }

    _runWinnerEngineDemonstration() {

        const { configurationEngine, physicsEngine, winnerEngine } = this._engines;

        const gameId = "winner-demo-game";

        const configuration = configurationEngine.generateConfiguration(
            gameId,
            {
                roomId: "winner-demo-room",
                stake: 1
            },
            createStandardConfigurationPlayers([
                "winner-player-1",
                "winner-player-2",
                "winner-player-3"
            ])
        );

        if (!configuration) {

            return;

        }

        physicsEngine.createSimulation(gameId);

        physicsEngine.startSimulation(gameId);

        physicsEngine.applyAcceleration(gameId, Math.PI);

        physicsEngine.updateSimulation(gameId, 50);

        physicsEngine.applyBrake(gameId);

        let snapshot = physicsEngine.getSimulation(gameId);

        while (snapshot?.runtime.state === "BRAKING") {

            physicsEngine.updateSimulation(gameId, 25);

            snapshot = physicsEngine.getSimulation(gameId);

        }

        winnerEngine.resolveResult(gameId);

        winnerEngine.removeResult(gameId);

        configurationEngine.removeConfiguration(gameId);

        physicsEngine.removeSimulation(gameId);

        this._logger.info("");

    }

    _runPaymentEngineDemonstration() {

        const {
            configurationEngine,
            physicsEngine,
            winnerEngine,
            paymentEngine
        } = this._engines;

        const gameId = "payment-demo-game";

        configurationEngine.generateConfiguration(
            gameId,
            { roomId: "payment-demo-room", stake: 10 },
            createStandardConfigurationPlayers([
                "payment-player-1",
                "payment-player-2",
                "payment-player-3"
            ])
        );

        physicsEngine.createSimulation(gameId);

        physicsEngine.startSimulation(gameId);

        physicsEngine.stopSimulation(gameId);

        winnerEngine.resolveResult(gameId);

        paymentEngine.preparePayment(gameId);

        paymentEngine.processPayment(gameId);

        paymentEngine.removePayment(gameId);

        winnerEngine.removeResult(gameId);

        configurationEngine.removeConfiguration(gameId);

        physicsEngine.removeSimulation(gameId);

        this._logger.info("");

    }

    _runRecoveryEngineDemonstration() {

        const {
            configurationEngine,
            gameStateEngine,
            gameClockEngine,
            physicsEngine
        } = this._engines;

        const gameId = "recovery-demo-game";

        const playerIds = [
            "recovery-player-1",
            "recovery-player-2",
            "recovery-player-3"
        ];

        configurationEngine.generateConfiguration(
            gameId,
            { roomId: "recovery-demo-room", stake: 10 },
            createStandardConfigurationPlayers(playerIds)
        );

        gameStateEngine.initializeGameState(gameId);

        gameStateEngine.transition(gameId, "COUNTDOWN", { reason: "demo" });

        gameStateEngine.transition(gameId, "SELF_TEST", { reason: "demo" });

        gameStateEngine.transition(gameId, "SPEED", { reason: "demo" });

        gameClockEngine.createClock(gameId);

        gameClockEngine.startClock(gameId);

        physicsEngine.createSimulation(gameId);

        physicsEngine.startSimulation(gameId);

        for (const playerId of playerIds) {

            this._inputAuthority.registerPlayer(gameId, playerId);

        }

        this._recoveryEngine.recoverPlayer(gameId, playerIds[0]);

        this._recoveryEngine.recoverSession(gameId);

        this._recoveryEngine.removeRecoverySnapshot(gameId);

        gameClockEngine.stopClock(gameId);

        gameClockEngine.removeClock(gameId);

        physicsEngine.stopSimulation(gameId);

        physicsEngine.removeSimulation(gameId);

        gameStateEngine.removeState(gameId);

        for (const playerId of playerIds) {

            this._inputAuthority.removePlayer(gameId, playerId);

        }

        configurationEngine.removeConfiguration(gameId);

        this._logger.info("");

    }

    _runAuditEngineDemonstration() {

        const {
            configurationEngine,
            gameStateEngine,
            gameClockEngine,
            physicsEngine,
            winnerEngine,
            paymentEngine
        } = this._engines;

        const gameId = "audit-demo-game";

        const playerIds = [
            "audit-player-1",
            "audit-player-2",
            "audit-player-3"
        ];

        configurationEngine.generateConfiguration(
            gameId,
            { roomId: "audit-demo-room", stake: 10 },
            createStandardConfigurationPlayers(playerIds)
        );

        gameStateEngine.initializeGameState(gameId);

        gameStateEngine.transition(gameId, "COUNTDOWN", { reason: "demo" });

        gameStateEngine.transition(gameId, "SELF_TEST", { reason: "demo" });

        gameStateEngine.transition(gameId, "SPEED", { reason: "demo" });

        gameStateEngine.transition(gameId, "BRAKE", { reason: "demo" });

        gameStateEngine.transition(gameId, "RESULT", { reason: "demo" });

        gameClockEngine.createClock(gameId);

        gameClockEngine.startClock(gameId);

        gameClockEngine.stopClock(gameId);

        physicsEngine.createSimulation(gameId);

        physicsEngine.startSimulation(gameId);

        physicsEngine.stopSimulation(gameId);

        for (const playerId of playerIds) {

            this._inputAuthority.registerPlayer(gameId, playerId);

        }

        winnerEngine.resolveResult(gameId);

        paymentEngine.preparePayment(gameId);

        paymentEngine.processPayment(gameId);

        this._recoveryEngine.recoverSession(gameId);

        this._auditEngine.buildAuditReport(gameId);

        this._auditEngine.verifyGame(gameId);

        this._auditEngine.removeAuditReport(gameId);

        this._recoveryEngine.removeRecoverySnapshot(gameId);

        paymentEngine.removePayment(gameId);

        winnerEngine.removeResult(gameId);

        gameClockEngine.removeClock(gameId);

        physicsEngine.removeSimulation(gameId);

        gameStateEngine.removeState(gameId);

        for (const playerId of playerIds) {

            this._inputAuthority.removePlayer(gameId, playerId);

        }

        configurationEngine.removeConfiguration(gameId);

        this._logger.info("");

    }

    _runEventBusDemonstration() {

        this._eventBus.emit({
            source: EVENT_SOURCES.APPLICATION,
            type: EVENT_TYPES.TEST_EVENT,
            payload: {
                source: "startup_demonstration"
            }
        });

        if (this._eventBusConfig.showDebugPanel) {

            printEventBusDebugPanel({
                logger: this._logger,
                eventBus: this._eventBus
            });

        }

    }

    _shutdownEventBus() {

        if (!this._eventBus) {

            return;

        }

        this._logger.disconnectEventBus();

        this._eventBus.shutdown();

        this._eventBus = null;

    }

    _shutdownServices() {

        this._services.tonService.shutdown();

        this._services.randomService.shutdown();

        this._services.timerService.shutdown();

        if (this._metricsService) {

            this._metricsService.shutdown();

        }

        this._logger.shutdown();

    }

    async _safeShutdownStep(label, step) {

        try {

            await step();

        } catch (error) {

            this._logger.error(`Shutdown step failed: ${label}`, error);

        }

    }

    _runStartupDemonstrations() {

        // Retired after C3.8+/C4.x. These development demonstrations predate the
        // authoritative activation layer (WinnerActivation, PaymentActivation,
        // AuditActivation, GameplayLifecycle), which is now always initialized and
        // subscribed to the shared EventBus. Because the demos drive the real
        // engines on that same bus, they collide with the live pipeline — e.g.
        // driving physics to a stop makes WinnerActivation resolve the winner
        // automatically, so the demo's own winnerEngine.resolveResult() then
        // throws "Result already exists". Running them would double-drive the
        // authoritative flow. They are intentionally skipped so startup stays
        // clean; the gameplay architecture is unchanged.
        this._logger.info(
            "Startup demonstrations skipped "
                + "(incompatible with authoritative activation pipeline)."
        );

        this._logger.info("");

    }

    _createManagers() {

        return {
            gameManager: new GameManager({
                logger: this._logger,
                eventBus: this._eventBus
            }),
            roomManager: new RoomManager({
                logger: this._logger,
                eventBus: this._eventBus,
                roomConfig: this._roomConfig
            }),
            playerManager: new PlayerManager({
                logger: this._logger,
                eventBus: this._eventBus
            })
        };

    }

    _initializeManagers() {

        this._managers.gameManager.initialize();

        this._logger.startupLine("GameManager");

        this._managers.roomManager.initialize();

        this._logger.startupLine("RoomManager");

        this._managers.playerManager.initialize();

        this._logger.startupLine("PlayerManager");

    }

    _shutdownManagers() {

        this._managers.playerManager.shutdown();

        this._managers.roomManager.shutdown();

        this._managers.gameManager.shutdown();

    }

    _createEngines() {

        const gameClockEngine = new GameClockEngine({
            logger: this._logger,
            eventBus: this._eventBus,
            gameCatalog: this._gameCatalog
        });

        const configurationEngine = new ConfigurationEngine({
            logger: this._logger,
            eventBus: this._eventBus,
            gameCatalog: this._gameCatalog,
            randomService: this._services.randomService
        });

        const physicsEngine = new PhysicsEngine({
            logger: this._logger,
            eventBus: this._eventBus,
            gameClock: gameClockEngine,
            metricsService: this._metricsService
        });

        const winnerEngine = new WinnerEngine({
            logger: this._logger,
            eventBus: this._eventBus,
            physicsEngine,
            configurationEngine,
            gameCatalog: this._gameCatalog
        });

        const telegramWalletAdapter = new TelegramWalletAdapter({
            logger: this._logger
        });

        return {
            configurationEngine,
            gameStateEngine: new GameStateEngine({
                logger: this._logger,
                eventBus: this._eventBus
            }),
            gameClockEngine,
            physicsEngine,
            winnerEngine,
            paymentEngine: new PaymentEngine({
                logger: this._logger,
                eventBus: this._eventBus,
                winnerEngine,
                configurationEngine,
                gameCatalog: this._gameCatalog,
                telegramWalletAdapter,
                metricsService: this._metricsService
            })
        };

    }

    _initializeEngines() {

        this._engines.configurationEngine.initialize();

        this._logger.startupLine("ConfigurationEngine");

        this._engines.gameStateEngine.initialize();

        this._logger.startupLine("GameStateEngine");

        this._engines.gameClockEngine.initialize();

        this._logger.startupLine("GameClockEngine");

        this._engines.physicsEngine.initialize();

        this._logger.startupLine("PhysicsEngine");

        this._engines.winnerEngine.initialize();

        this._logger.startupLine("WinnerEngine");

        this._engines.paymentEngine.initialize();

        this._logger.startupLine("PaymentEngine");

    }

    _shutdownEngines() {

        this._engines.paymentEngine.shutdown();

        this._engines.winnerEngine.shutdown();

        this._engines.physicsEngine.shutdown();

        this._engines.gameClockEngine.shutdown();

        this._engines.gameStateEngine.shutdown();

        this._engines.configurationEngine.shutdown();

    }

    _createExpressApp() {

        const app = express();

        app.use(cors({
            origin: this._serverConfig.clientOrigin
        }));

        app.get("/", (req, res) => {

            res.send("WheelWin Server Running");

        });

        app.get("/health", (req, res) => {

            res.json(this._healthService.getHealthSnapshot());

        });

        // R6.4 / R6.5B — Native Game Report download (JSON / TXT).
        // Content-Disposition: attachment + Content-Length so browsers use the
        // standard file-download path (no client-side Blob required).
        const sendGameReportDownload = (req, res) => {

            const id = req.params.reportId ?? req.params.gameId;

            const report = this._gameReportEngine?.resolveReport?.(id)
                ?? this._gameReportEngine?.getReport?.(id);

            if (!report) {

                this._logger?.error?.(
                    `[GameReport] Download 404 | id=${id}`
                );

                res.status(404).json({ error: "Game report not found" });

                return;

            }

            const wantsText = String(req.query.format ?? "")
                .toLowerCase() === "txt"
                || String(req.headers.accept ?? "").includes("text/plain");

            const reportId = report.reportId ?? report.gameId ?? id;

            const body = wantsText
                ? (this._gameReportEngine.getReportText(report.gameId) ?? "")
                : `${JSON.stringify(report, null, 2)}\n`;

            const buffer = Buffer.from(body, "utf8");

            const contentType = "application/octet-stream";

            const filename = wantsText
                ? `${reportId}.txt`
                : `${reportId}.json`;

            this._logger?.info?.(
                [
                    "[GameReport] Download",
                    `id=${id}`,
                    `reportId=${reportId}`,
                    `format=${wantsText ? "txt" : "json"}`,
                    `bytes=${buffer.length}`,
                    `status=200`
                ].join(" | ")
            );

            res.status(200);
            res.setHeader("Content-Type", contentType);
            res.setHeader(
                "Content-Disposition",
                `attachment; filename="${filename}"`
            );
            res.setHeader("Content-Length", String(buffer.length));
            res.setHeader("Cache-Control", "no-store");
            res.end(buffer);

        };

        app.get(
            "/api/game-report/:reportId/download",
            sendGameReportDownload
        );

        // Compatibility alias (gameId or reportId without /download).
        app.get("/api/game-report/:gameId", sendGameReportDownload);

        if (this._eventBusConfig.showDebugPanel) {

            app.get("/debug/health", (req, res) => {

                res.json(this._healthService.getHealthSnapshot());

            });

            app.get("/debug/metrics", (req, res) => {

                res.json(this._metricsService.getSnapshot());

            });

            app.get("/debug/event-bus", (req, res) => {

                res.json(this._eventBus.getDebugSnapshot());

            });

            app.get("/debug/games", (req, res) => {

                res.json(this._managers.gameManager.getDebugSnapshot());

            });

            app.get("/debug/rooms", (req, res) => {

                res.json(this._managers.roomManager.getDebugSnapshot());

            });

            app.get("/debug/players", (req, res) => {

                res.json(this._managers.playerManager.getDebugSnapshot());

            });

            app.get("/debug/catalog", (req, res) => {

                res.json(this._gameCatalog.getDebugSnapshot());

            });

            app.get("/debug/random", (req, res) => {

                res.json(this._services.randomService.getDebugSnapshot());

            });

            app.get("/debug/configuration/:gameId", (req, res) => {

                const snapshot = this._engines.configurationEngine
                    .getDebugSnapshot(req.params.gameId);

                if (!snapshot) {

                    res.status(404).json({ error: "Configuration not found" });

                    return;

                }

                res.json(snapshot);

            });

            app.get("/debug/game-state/:gameId", (req, res) => {

                const snapshot = this._engines.gameStateEngine
                    .getDebugSnapshot(req.params.gameId);

                if (!snapshot) {

                    res.status(404).json({ error: "Game state not found" });

                    return;

                }

                res.json(snapshot);

            });

            app.get("/debug/game-clock/:gameId", (req, res) => {

                const snapshot = this._engines.gameClockEngine
                    .getDebugSnapshot(req.params.gameId);

                if (!snapshot) {

                    res.status(404).json({ error: "Game clock not found" });

                    return;

                }

                res.json(snapshot);

            });

            app.get("/debug/physics/:gameId", (req, res) => {

                const snapshot = this._engines.physicsEngine
                    .getDebugSnapshot(req.params.gameId);

                if (!snapshot) {

                    res.status(404).json({ error: "Physics simulation not found" });

                    return;

                }

                res.json(snapshot);

            });

            app.get("/debug/input/:gameId/:playerId", (req, res) => {

                const snapshot = this._inputAuthority.getDebugSnapshot(
                    req.params.gameId,
                    req.params.playerId
                );

                if (!snapshot) {

                    res.status(404).json({ error: "Input state not found" });

                    return;

                }

                res.json(snapshot);

            });

            app.get("/debug/result/:gameId", (req, res) => {

                const snapshot = this._engines.winnerEngine
                    .getDebugSnapshot(req.params.gameId);

                if (!snapshot) {

                    res.status(404).json({ error: "Game result not found" });

                    return;

                }

                res.json(snapshot);

            });

            app.get("/debug/payment/:gameId", (req, res) => {

                const snapshot = this._engines.paymentEngine
                    .getDebugSnapshot(req.params.gameId);

                if (!snapshot) {

                    res.status(404).json({ error: "Payment not found" });

                    return;

                }

                res.json(snapshot);

            });

            app.get("/debug/recovery/:gameId", (req, res) => {

                res.json(
                    this._recoveryEngine.getDebugSnapshot(req.params.gameId)
                );

            });

            app.get("/debug/audit/:gameId", (req, res) => {

                res.json(
                    this._auditEngine.getDebugSnapshot(req.params.gameId)
                );

            });

        }

        return app;

    }

    _listen() {

        const { host, port } = this._serverConfig;

        return new Promise((resolve, reject) => {

            this._httpServer.once("error", reject);

            this._httpServer.listen(port, host, () => {

                this._httpServer.removeListener("error", reject);

                resolve();

            });

        });

    }

    _closeHttpServer() {

        if (!this._httpServer) {

            return Promise.resolve();

        }

        return new Promise((resolve, reject) => {

            this._httpServer.close((error) => {

                this._httpServer = null;

                if (error) {

                    reject(error);

                    return;

                }

                resolve();

            });

        });

    }

    _registerShutdownHandlers() {

        const handleSignal = async (signal) => {

            this._logger.info(`Received ${signal}`);

            try {

                await this.shutdown();

                process.exit(0);

            } catch (error) {

                this._logger.error("Shutdown failed", error);

                process.exit(1);

            }

        };

        process.once("SIGINT", () => {

            handleSignal("SIGINT");

        });

        process.once("SIGTERM", () => {

            handleSignal("SIGTERM");

        });

    }

}

const application = new WheelWinApplication();

application.start().catch((error) => {

    const logger = new LoggerService();

    logger.initialize();

    if (error instanceof LifecycleError) {

        logger.error(error.message);

        if (error.cause) {

            logger.error("Caused by", error.cause);

        }

    } else {

        logger.error("Server startup failed", error);

    }

    process.exit(1);

});
