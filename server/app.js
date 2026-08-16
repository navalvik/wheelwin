import "dotenv/config";

import cors from "cors";
import express from "express";
import http from "http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { GameCatalog } from "./catalog/GameCatalog.js";
import { ConfigurationManager } from "./config/ConfigurationManager.js";
import { ConfigurationError } from "./config/ConfigurationError.js";
import { OwnerConfiguration } from "./config/OwnerConfiguration.js";
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
import { LoggingManager } from "./logging/LoggingManager.js";
import { GameDiagnosticLogManager } from "./logging/GameDiagnosticLogManager.js";
import { SessionHistoryArchiveManager } from "./history/SessionHistoryArchiveManager.js";
import { LOG_LEVELS } from "./logging/levels.js";
import { MonitoringManager } from "./monitoring/MonitoringManager.js";
import { FailurePolicyManager } from "./failure/FailurePolicyManager.js";
import { DeploymentManager } from "./deployment/DeploymentManager.js";
import { ReleaseManager } from "./release/ReleaseManager.js";
import { ReleaseCertificationManager } from "./certification/ReleaseCertificationManager.js";
import { ClosedBetaManager } from "./beta/ClosedBetaManager.js";
import { LaunchReadinessManager } from "./launch/LaunchReadinessManager.js";
import { GeneralAvailabilityManager } from "./ga/GeneralAvailabilityManager.js";
import { OperationsManager } from "./operations/OperationsManager.js";
import { GovernanceManager } from "./governance/GovernanceManager.js";

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
    buildGameplayPhaseTimers
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
import { ContractSettlementManager } from "./payment/ContractSettlementManager.js";
import { GameContractDeployAdapter } from "./payment/GameContractDeployAdapter.js";
import { TonGameContractAdapter } from "./payment/TonGameContractAdapter.js";
import { deriveDeployerWalletIdentity } from "./payment/ton/deriveDeployerWalletIdentity.js";
import {
    assertDeployerWalletMatchesExpected,
    printTonWalletIdentityDebug,
    setTonWalletIdentityDebug,
    tonAddressesEqual
} from "./diagnostics/TonWalletIdentityDebug.js";
import {
    assertMainnetStartupSafe,
    evaluateMainnetReadiness,
    printTonMainnetDryRunDebug,
    printTonMainnetReadiness,
    setTonMainnetReadiness
} from "./diagnostics/TonMainnetReadiness.js";
import {
    printTonMainnetWalletIdentityDebug,
    setTonMainnetWalletIdentityDebug
} from "./diagnostics/TonMainnetWalletIdentityDebug.js";
import {
    printTonTestnetOracleDebug,
    setTonTestnetOracleDebug
} from "./diagnostics/TonTestnetOracleDebug.js";
import {
    evaluateTonTestnetWalletReadiness,
    printTonTestnetWalletReadiness,
    setTonTestnetWalletReadiness
} from "./diagnostics/TonTestnetWalletReadiness.js";
import { verifyGameEscrowArtifact } from "./payment/ton/verifyGameEscrowArtifact.js";
import {
    BlockchainMonitor,
    EntryPaymentAuditLedger
} from "./payment/BlockchainMonitor.js";
import { SessionWalletStore } from "./session/SessionWalletStore.js";
import { TonFinancialRecovery } from "./recovery/TonFinancialRecovery.js";
import { TonFinancialPersistence } from "./persistence/TonFinancialPersistence.js";
import { DeploymentCostSnapshotRepository } from "./payment/reimbursement/DeploymentCostSnapshotRepository.js";
import { DeploymentCostService } from "./payment/reimbursement/DeploymentCostService.js";
import { DeploymentReimbursementRepository } from "./payment/reimbursement/DeploymentReimbursementRepository.js";
import { DeploymentReimbursementService } from "./payment/reimbursement/DeploymentReimbursementService.js";
import { DeploymentReimbursementWorker } from "./payment/reimbursement/DeploymentReimbursementWorker.js";
import { ReimbursementTransferService } from "./payment/reimbursement/ReimbursementTransferService.js";
import { ForensicArchiveService } from "./forensic/ForensicArchiveService.js";
import { R2ForensicArchiveUploader } from "./forensic/R2ForensicArchiveUploader.js";
import { resolveForensicArchiveConfig } from "./forensic/forensicArchiveConfig.js";

const SERVER_ROOT_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * R8.10 — Resolve durable financial storage directory.
 * Priority: TON_FINANCIAL_DATA_DIR → WHEELWIN_FINANCIAL_DATA_DIR → server/data/ton-financial
 */
function resolveTonFinancialDataDir(env = process.env) {

    const fromEnv = String(
        env.TON_FINANCIAL_DATA_DIR
            || env.WHEELWIN_FINANCIAL_DATA_DIR
            || ""
    ).trim();

    if (fromEnv) {

        return fromEnv;

    }

    return join(SERVER_ROOT_DIR, "data", "ton-financial");

}

import { DeveloperConsoleProjectionService } from "./console/DeveloperConsoleProjectionService.js";
import { registerDeveloperConsoleRoutes } from "./console/registerDeveloperConsoleRoutes.js";
import { DeveloperConsoleGateway } from "./console/DeveloperConsoleGateway.js";
import { DeveloperAuthService } from "./console/auth/DeveloperAuthService.js";
import { createDeveloperAuthMiddleware } from "./console/auth/developerAuthMiddleware.js";
import { registerDeveloperAuthRoutes } from "./console/auth/registerDeveloperAuthRoutes.js";
import { AppEnvironmentService } from "./console/environment/AppEnvironmentService.js";
import { registerEnvironmentControlRoutes } from "./console/environment/registerEnvironmentControlRoutes.js";
import { MaintenanceService } from "./console/maintenance/MaintenanceService.js";
import { registerMaintenanceRoutes } from "./console/maintenance/registerMaintenanceRoutes.js";
import { registerAdvertisementRoutes } from "./console/registerAdvertisementRoutes.js";
import { AdvertisementManager } from "./advertisement/AdvertisementManager.js";
import { resolveAdvertisementR2Config } from "./advertisement/advertisementR2Config.js";
import { AdvertisementSelectionEngine } from "./advertisement/AdvertisementSelectionEngine.js";
import { AdvertisementScheduler } from "./advertisement/AdvertisementScheduler.js";
import { AdvertisementLifecycleManager } from "./advertisement/AdvertisementLifecycleManager.js";
import { AdvertisementHistoryService } from "./advertisement/AdvertisementHistoryService.js";
import { AdvertisementRedirectService } from "./advertisement/AdvertisementRedirectService.js";
import { ApplicationLifecycleManager } from "./lifecycle/ApplicationLifecycleManager.js";
import { APPLICATION_LIFECYCLE } from "./lifecycle/ApplicationLifecycleStates.js";

class WheelWinApplication {
    constructor() {

        this._logger = null;

        this._runtimeConfig = null;

        this._serverConfig = null;

        this._productionConfig = null;

        this._metricsService = null;

        this._healthService = null;

        this._operationalMetrics = null;

        this._startupStartedAt = 0;

        this._serverStartedAt = 0;

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

        this._gameDiagnosticLogManager = null;

        this._sessionHistoryArchive = null;

        this._resultSessionLifecycle = null;

        this._paymentSessionManager = null;

        this._gameContractManager = null;

        this._deploymentCostService = null;

        this._gameStartAuthorization = null;

        this._contractSettlementManager = null;

        this._consoleProjectionService = null;

        this._consoleGateway = null;

        this._developerAuthService = null;

        this._blockchainMonitor = null;

        this._entryPaymentAuditLedger = null;

        this._sessionWalletStore = null;

        this._financialPersistence = null;

        this._tonFinancialRecovery = null;

        this._tonConfig = null;

        this._lifecycleManager = null;

        this._monitoringManager = null;

        this._failurePolicyManager = null;

        this._deploymentManager = null;

        this._releaseManager = null;

        this._certificationManager = null;

        this._closedBetaManager = null;

        this._launchReadinessManager = null;

        this._generalAvailabilityManager = null;

        this._operationsManager = null;

        this._governanceManager = null;

        this._httpStats = {
            requests: 0,
            errors: 0,
            totalLatencyMs: 0
        };

        this._prometheusServer = null;

        this._isShuttingDown = false;

        this._collectingRuntime = false;

    }

    async start() {

        this._startupStartedAt = performance.now();

        this._serverStartedAt = Date.now();

        process.env.SERVER_STARTED_AT = String(this._serverStartedAt);

        // R7.0C — fail-fast immutable configuration before RUNNING.
        this._runtimeConfig = ConfigurationManager.load();

        this._serverConfig = this._runtimeConfig.server;

        this._productionConfig = this._runtimeConfig.production;

        this._tonConfig = this._runtimeConfig.ton;

        this._roomConfig = this._runtimeConfig.rooms;

        this._eventBusConfig = this._runtimeConfig.eventBus;

        this._gameplayPhaseConfig = this._runtimeConfig.gameplayPhases;

        // R7.0D — centralized structured logging before other services.
        const loggingManager = LoggingManager.getInstance();

        loggingManager.initialize({
            ...this._productionConfig.logging,
            environment: this._serverConfig.nodeEnv,
            profile: this._runtimeConfig.profile,
            version: this._runtimeConfig.version
        });

        this._logger = new LoggerService({
            logLevel: this._productionConfig.logLevel,
            loggingManager
        });

        this._logger.initialize();

        loggingManager.audit("startup", {
            lifecycleState: APPLICATION_LIFECYCLE.STARTING
        });

        this._metricsService = new MetricsService({
            enabled: this._productionConfig.metricsEnabled
        });

        this._healthService = new HealthService({
            logger: this._logger,
            productionConfig: this._productionConfig
        });

        this._healthService.setSafeConfiguration(
            this._runtimeConfig.toSafeSummary()
        );

        this._healthService.setLoggerStatus(loggingManager.getSafeStatus());

        // R7.0F — centralized failure recovery policies (operational only).
        this._failurePolicyManager = FailurePolicyManager.getInstance();

        const failurePolicyConfig = this._productionConfig.failurePolicy ?? {};

        this._failurePolicyManager.initialize({
            ...failurePolicyConfig,
            onShutdownRequest: () => {

                setImmediate(() => {

                    if (this._isShuttingDown) {

                        return;

                    }

                    this.shutdown({ reason: "failure_policy_fatal" })
                        .catch(() => {
                            // lifecycle already logging
                        });

                });

            }
        });

        this._healthService.setFailurePolicyStatus(
            this._failurePolicyManager.getSafeStatus()
        );

        this._logger.startupLine(
            failurePolicyConfig.enabled === false
                ? "FailurePolicyManager (disabled)"
                : "FailurePolicyManager"
        );

        // R8.0B — release metadata for health / console (build via CLI).
        this._releaseManager = ReleaseManager.getInstance();

        const releaseConfig = this._productionConfig.release ?? {};

        this._releaseManager.initialize({
            channel: releaseConfig.channel,
            outputDirectory: releaseConfig.outputDirectory,
            signingEnabled: releaseConfig.signingEnabled,
            generateChecksums: releaseConfig.generateChecksums,
            includeDocs: releaseConfig.includeDocs,
            includeReports: releaseConfig.includeReports,
            version: this._runtimeConfig.version,
            profile: this._runtimeConfig.profile
        });

        this._healthService.setReleaseStatus(
            this._releaseManager.getSafeStatus()
        );

        this._logger.startupLine(
            `ReleaseManager (${releaseConfig.channel ?? "development"})`
        );

        // R8.0C — RC certification status (certify via CLI against release package).
        this._certificationManager = ReleaseCertificationManager.getInstance();

        this._certificationManager.initialize({
            productionConfig: this._productionConfig,
            runtimeConfig: this._runtimeConfig,
            tonConfig: this._runtimeConfig.ton,
            safeConfiguration: this._runtimeConfig.toSafeSummary(),
            profile: this._runtimeConfig.profile,
            providers: {
                logging: () => LoggingManager.getInstance().getSafeStatus(),
                monitoring: () => this._monitoringManager?.getHealthStatus?.()
                    ?? null,
                monitoringSnapshot: () => this._monitoringManager?.getSnapshot?.()
                    ?? null,
                failurePolicy: () => this._failurePolicyManager?.getSafeStatus?.()
                    ?? null,
                deploymentHealth: () => this._deploymentManager
                    ?.getHealthManager?.()
                    ?.getSafeStatus?.() ?? null,
                healthSnapshot: () => this._healthService.getHealthSnapshot(),
                developerConsole: () => ({
                    enabled: this._developerAuthService?.isEnabled?.() === true
                })
            }
        });

        this._healthService.setCertificationStatus(
            this._certificationManager.getSafeStatus()
        );

        this._logger.startupLine(
            `ReleaseCertificationManager (${this._certificationManager.getStatus()})`
        );

        // R8.0D — Closed Beta operations (observational telemetry / feedback).
        this._closedBetaManager = ClosedBetaManager.getInstance();

        const closedBetaConfig = this._productionConfig.closedBeta ?? {};

        this._closedBetaManager.initialize({
            config: {
                enabled: closedBetaConfig.enabled !== false,
                requireCertification:
                    closedBetaConfig.requireCertification !== false,
                maxParticipants: closedBetaConfig.maxParticipants ?? 500
            },
            providers: {
                metricsService: this._metricsService,
                monitoringManager: this._monitoringManager,
                monitoringSnapshot: () => this._monitoringManager?.getSnapshot?.()
                    ?? null,
                releaseManager: this._releaseManager,
                certificationManager: this._certificationManager,
                gameManager: this._managers?.gameManager,
                environment: () => this._serverConfig?.nodeEnv ?? null,
                profile: () => this._runtimeConfig?.profile ?? null,
                version: () => this._runtimeConfig?.version ?? null
            },
            installCrashHandlers: closedBetaConfig.enabled !== false
        });

        this._healthService.setClosedBetaStatus(
            this._closedBetaManager.getSafeStatus()
        );

        this._logger.startupLine(
            `ClosedBetaManager (${this._closedBetaManager.getLifecycle()})`
        );

        // R8.0E — Open Beta / GA / Production launch gates (observational).
        this._launchReadinessManager = LaunchReadinessManager.getInstance();

        const launchConfig = this._productionConfig.launch ?? {};

        this._launchReadinessManager.initialize({
            config: {
                enabled: launchConfig.enabled !== false,
                requireMainnetForGa:
                    launchConfig.requireMainnetForGa !== false
            },
            providers: {
                closedBetaManager: this._closedBetaManager,
                certificationManager: this._certificationManager,
                releaseManager: this._releaseManager,
                monitoringManager: this._monitoringManager,
                healthSnapshot: () => this._healthService.getHealthSnapshot(),
                deploymentHealth: () => this._deploymentManager
                    ?.getHealthManager?.()
                    ?.getSafeStatus?.() ?? null,
                tonConfig: () => this._runtimeConfig?.ton ?? null,
                safeConfiguration: () => this._runtimeConfig?.toSafeSummary?.()
                    ?? null,
                logging: () => LoggingManager.getInstance().getSafeStatus(),
                failurePolicy: () => this._failurePolicyManager?.getSafeStatus?.()
                    ?? null,
                developerConsole: () => ({
                    enabled: this._developerAuthService?.isEnabled?.() === true
                }),
                version: () => this._runtimeConfig?.version ?? null
            }
        });

        this._healthService.setLaunchStatus(
            this._launchReadinessManager.getSafeStatus()
        );

        this._logger.startupLine(
            `LaunchReadinessManager (${this._launchReadinessManager.getLifecycle()})`
        );

        // R9.0A — General Availability release orchestration (observational).
        this._generalAvailabilityManager =
            GeneralAvailabilityManager.getInstance();

        const gaConfig = this._productionConfig.ga ?? {};

        this._generalAvailabilityManager.initialize({
            config: {
                enabled: gaConfig.enabled !== false,
                rolloutMode: gaConfig.rolloutMode ?? "single",
                verifyAfterRelease: gaConfig.verifyAfterRelease !== false,
                postLaunchMonitoringHours:
                    gaConfig.postLaunchMonitoringHours ?? 72,
                requireCertification: gaConfig.requireCertification !== false
            },
            providers: {
                closedBetaManager: this._closedBetaManager,
                launchReadinessManager: this._launchReadinessManager,
                certificationManager: this._certificationManager,
                releaseManager: this._releaseManager,
                monitoringManager: this._monitoringManager,
                healthSnapshot: () => this._healthService.getHealthSnapshot(),
                deploymentHealth: () => this._deploymentManager
                    ?.getHealthManager?.()
                    ?.getSafeStatus?.() ?? null,
                tonConfig: () => this._runtimeConfig?.ton ?? null,
                safeConfiguration: () => this._runtimeConfig?.toSafeSummary?.()
                    ?? null,
                logging: () => LoggingManager.getInstance().getSafeStatus(),
                failurePolicy: () => this._failurePolicyManager?.getSafeStatus?.()
                    ?? null,
                developerConsole: () => ({
                    enabled: this._developerAuthService?.isEnabled?.() === true
                }),
                version: () => this._runtimeConfig?.version ?? null
            }
        });

        this._healthService.setGaStatus(
            this._generalAvailabilityManager.getSafeStatus()
        );

        this._logger.startupLine(
            `GeneralAvailabilityManager (${this._generalAvailabilityManager.getLifecycle()})`
        );

        // R9.0B — Post-launch operations (observational continuous supervision).
        this._operationsManager = OperationsManager.getInstance();

        const operationsConfig = this._productionConfig.operations ?? {};

        this._operationsManager.initialize({
            config: {
                enabled: operationsConfig.enabled !== false,
                slaAvailabilityTarget:
                    operationsConfig.slaAvailabilityTarget ?? 0.995,
                slaLatencyTargetMs:
                    operationsConfig.slaLatencyTargetMs ?? 250,
                slaRecoveryTarget: operationsConfig.slaRecoveryTarget ?? 0.95,
                maintenanceDefaultDurationMinutes:
                    operationsConfig.maintenanceDefaultDurationMinutes ?? 60,
                versionSupportWindowDays:
                    operationsConfig.versionSupportWindowDays ?? 90
            },
            providers: {
                metricsService: this._metricsService,
                monitoringManager: this._monitoringManager,
                healthSnapshot: () => this._healthService.getHealthSnapshot(),
                deploymentHealth: () => this._deploymentManager
                    ?.getHealthManager?.()
                    ?.getSafeStatus?.() ?? null,
                closedBetaManager: this._closedBetaManager,
                generalAvailabilityManager: this._generalAvailabilityManager,
                releaseManager: this._releaseManager,
                gameManager: this._managers?.gameManager,
                version: () => this._runtimeConfig?.version ?? null
            },
            initialVersion: this._runtimeConfig?.version ?? "1.0.0"
        });

        this._healthService.setOperationsStatus(
            this._operationsManager.getSafeStatus()
        );

        this._logger.startupLine(
            `OperationsManager (${this._operationsManager.getLifecycle()})`
        );

        // R9.0C — Long-term platform governance (observational audit only).
        this._governanceManager = GovernanceManager.getInstance();

        const governanceConfig = this._productionConfig.governance ?? {};

        this._governanceManager.initialize({
            config: {
                enabled: governanceConfig.enabled !== false,
                auditIntervalDays:
                    governanceConfig.auditIntervalDays ?? 30,
                complianceRequired:
                    governanceConfig.complianceRequired !== false,
                riskReviewIntervalDays:
                    governanceConfig.riskReviewIntervalDays ?? 30,
                evidenceRetentionDays:
                    governanceConfig.evidenceRetentionDays ?? 365,
                platformReviewIntervalDays:
                    governanceConfig.platformReviewIntervalDays ?? 90
            },
            providers: {
                metricsService: this._metricsService,
                monitoringManager: this._monitoringManager,
                healthSnapshot: () => this._healthService.getHealthSnapshot(),
                deploymentHealth: () => this._deploymentManager
                    ?.getHealthManager?.()
                    ?.getSafeStatus?.() ?? null,
                operationsManager: this._operationsManager,
                closedBetaManager: this._closedBetaManager,
                generalAvailabilityManager: this._generalAvailabilityManager,
                releaseManager: this._releaseManager,
                certificationManager: this._certificationManager,
                failurePolicy: () => this._failurePolicyManager
                    ?.getSafeStatus?.() ?? null,
                safeConfiguration: () => this._runtimeConfig
                    ?.toSafeSummary?.() ?? null,
                developerConsole: () => ({
                    enabled: this._developerAuthService?.isEnabled?.() === true
                }),
                tonConfig: () => this._runtimeConfig?.ton
                    ? {
                        network: this._runtimeConfig.ton.network ?? null,
                        deployMode: this._runtimeConfig.ton.deployMode ?? null
                    }
                    : null,
                version: () => this._runtimeConfig?.version ?? null
            }
        });

        this._healthService.setGovernanceStatus(
            this._governanceManager.getSafeStatus()
        );

        this._logger.startupLine(
            `GovernanceManager (${this._governanceManager.getLifecycle()})`
        );

        // R7.0B — process lifecycle (RUNNING → DRAINING → STOPPED).
        this._lifecycleManager = new ApplicationLifecycleManager({
            logger: this._logger,
            metricsService: this._metricsService,
            healthService: this._healthService,
            loggingManager,
            gracefulShutdownTimeoutMs:
                this._productionConfig.gracefulShutdownTimeoutMs,
            activityProvider: () => this._collectDrainActivity()
        });

        this._healthService.setLifecycleState(APPLICATION_LIFECYCLE.STARTING);

        loggingManager.setLifecycleState(APPLICATION_LIFECYCLE.STARTING);

        this._logger.info("WheelWin Server");
        this._logger.info("Initializing...");

        ConfigurationManager.logStartupSummary(this._logger, this._runtimeConfig);

        this._logger.startupLine("ConfigurationManager");

        this._logger.startupLine("OwnerConfiguration");

        const socketConfig = this._runtimeConfig.socket;

        validateStartupConfiguration({
            serverConfig: this._serverConfig,
            tonConfig: this._tonConfig,
            roomConfig: this._roomConfig
        });

        this._services = this._createServices(this._tonConfig);

        this._initializeServices();

        // R7.67B — Railway wallet identity + balance diagnostics (fail on mismatch).
        await this._runTonWalletIdentityDiagnostics();

        // R7.70B — Testnet wallet readiness for settlement validation prep.
        await this._runTonTestnetWalletReadinessDiagnostics();

        // R7.68 — Mainnet readiness report (does not enable Mainnet).
        await this._runTonMainnetReadinessDiagnostics();

        this._metricsService.initialize();

        this._gameCatalog = new GameCatalog({
            logger: this._logger
        });

        this._gameCatalog.initialize();

        this._gameCatalog.configurePhaseTimers(
            buildGameplayPhaseTimers(this._gameplayPhaseConfig)
        );

        validateGameplayPhaseSequence();

        validateStartupConfiguration({
            serverConfig: this._serverConfig,
            tonConfig: this._tonConfig,
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
            gameManager: this._managers.gameManager,
            roomConfig: this._roomConfig,
            devMode: this._productionConfig.isDevelopment
        });

        this._setupSessionLifecycle.initialize();

        this._managers.roomManager.attachSetupSessionLifecycle(
            this._setupSessionLifecycle
        );

        this._managers.roomManager.attachLifecycleGate(this._lifecycleManager);

        this._setupSessionLifecycle.attachLifecycleGate(this._lifecycleManager);

        this._logger.startupLine("SetupSessionLifecycle");

        // R6.2B — DEV-only per-room diagnostic files under logs/games/.
        this._gameDiagnosticLogManager = GameDiagnosticLogManager.getInstance();

        this._gameDiagnosticLogManager.initialize({
            enabled: this._productionConfig.isDevelopment === true,
            eventBus: this._eventBus,
            loggingManager: LoggingManager.getInstance(),
            playerManager: this._managers.playerManager
        });

        if (this._gameDiagnosticLogManager.isEnabled()) {

            this._logger.startupLine("GameDiagnosticLogManager");

        }

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
            configurationEngine: this._engines.configurationEngine,
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
            resultSessionLifecycle: this._resultSessionLifecycle,
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

        // R8.10 — Single shared TonFinancialPersistence for restart recovery.
        const financialDataDir = resolveTonFinancialDataDir();

        this._financialPersistence = new TonFinancialPersistence({
            logger: this._logger,
            dataDir: financialDataDir
        });

        const persistenceSummary = this._financialPersistence.initialize();

        this._logger.startupLine("TonFinancialPersistence");

        this._logger.info(
            `TonFinancialPersistence dataDir=${financialDataDir} | `
                + `records=${persistenceSummary?.recordCount ?? 0}`
        );

        this._sessionWalletStore = new SessionWalletStore({
            financialPersistence: this._financialPersistence,
            logger: this._logger
        });

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
            resultSessionLifecycle: this._resultSessionLifecycle,
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
            gameManager: this._managers.gameManager,
            roomConfig: this._roomConfig,
            gameplayContextResolver: this._gameplayContextResolver,
            sessionWalletStore: this._sessionWalletStore,
            blockchainMonitor: this._blockchainMonitor,
            financialPersistence: this._financialPersistence,
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
                deployDelayMs: this._productionConfig.isDevelopment ? 40 : 0,
                network: this._tonConfig.network
            })
            : new TonGameContractAdapter({
                logger: this._logger,
                tonConfig: this._tonConfig,
                transport: this._services.tonService.getTransport(),
                tonClient: this._services.tonService.getClient()
            });

        this._gameContractDeployAdapter = deployAdapter;

        // R7.69B — GameEscrow getters for payment recovery / reconnect sync.
        this._blockchainMonitor.setContractAdapter?.(deployAdapter);

        this._gameContractManager = new GameContractManager({
            logger: this._logger,
            eventBus: this._eventBus,
            playerManager: this._managers.playerManager,
            roomManager: this._managers.roomManager,
            gameManager: this._managers.gameManager,
            sessionWalletStore: this._sessionWalletStore,
            configurationEngine: this._engines.configurationEngine,
            deployAdapter,
            financialPersistence: this._financialPersistence,
            creatingDelayMs: this._productionConfig.isDevelopment ? 40 : 0,
            deployTimeoutMs: this._roomConfig?.gameContractDeployTimeoutMs
                ?? (2 * 60 * 1000),
            devMode: this._productionConfig.isDevelopment
        });

        this._gameContractManager.initialize();

        this._logger.startupLine("GameContractManager");

        // R17.8V.2P.J / R17.8V.2P.K — Deployment cost snapshot capture + freeze.
        this._deploymentCostService = new DeploymentCostService({
            repository: new DeploymentCostSnapshotRepository({
                persistence: this._financialPersistence,
                tonNetwork: this._tonConfig?.network ?? "testnet"
            }),
            eventBus: this._eventBus,
            transport: this._services?.tonService?.getTransport?.() ?? null,
            logger: this._logger,
            env: process.env
        });

        this._deploymentCostService.initialize();

        this._logger.startupLine("DeploymentCostService");

        // R17.8V.2P.M — Deployment reimbursement queue foundation (no TON send).
        this._deploymentReimbursementRepository = new DeploymentReimbursementRepository({
            persistence: this._financialPersistence,
            tonNetwork: this._tonConfig?.network ?? "testnet"
        });

        this._deploymentReimbursementService = new DeploymentReimbursementService({
            repository: this._deploymentReimbursementRepository,
            logger: this._logger,
            env: process.env
        });

        this._deploymentReimbursementService.initialize();

        this._deploymentReimbursementWorker = new DeploymentReimbursementWorker({
            repository: this._deploymentReimbursementRepository,
            transferService: new ReimbursementTransferService({
                logger: this._logger
            }),
            logger: this._logger,
            env: process.env
        });

        this._deploymentReimbursementWorker.initialize();

        this._logger.startupLine("DeploymentReimbursementWorker");

        const deployerWalletAddress = await this._resolveDeployerWalletAddress();

        this._contractSettlementManager = new ContractSettlementManager({
            logger: this._logger,
            eventBus: this._eventBus,
            gameContractManager: this._gameContractManager,
            winnerEngine: this._engines.winnerEngine,
            configurationEngine: this._engines.configurationEngine,
            settlementAdapter: deployAdapter,
            blockchainMonitor: this._blockchainMonitor,
            deployerWalletAddress,
            auditLedger: this._entryPaymentAuditLedger,
            paymentSessionManager: this._paymentSessionManager,
            gameplayContextResolver: this._gameplayContextResolver,
            gameManager: this._managers.gameManager,
            financialPersistence: this._financialPersistence,
            tonNetwork: this._tonConfig?.network ?? null,
            gameEscrowMode: this._tonConfig?.gameEscrowMode ?? null,
            devMode: this._productionConfig.isDevelopment
        });

        this._contractSettlementManager.initialize();

        // R5.19 — Page5 → Page6 must follow authoritative RESULT_COMPLETED →
        // OPEN_PAGE6. Settlement continues independently and must not gate
        // presentation navigation (SETTLEMENT_FAILED / hang left clients stuck
        // on Page5 after the winner was already shown).
        this._gameplayPhaseLifecycle.configureSettlementGate({ enabled: false });

        // R8.6 — GAME_DESTROYED waits for settlement terminal; OPEN_PAGE6 stays ungated.
        this._gameplayLifecycle.configureSettlementTeardownGate({
            contractSettlementManager: this._contractSettlementManager,
            gameContractManager: this._gameContractManager
        });

        // R8.8 — Cross-wire financial retention checks (SESSION_FINISHED / room).
        this._paymentSessionManager.setFinancialEvidenceDeps({
            gameContractManager: this._gameContractManager,
            contractSettlementManager: this._contractSettlementManager
        });

        this._gameContractManager.setFinancialEvidenceDeps({
            paymentSessionManager: this._paymentSessionManager,
            contractSettlementManager: this._contractSettlementManager
        });

        this._gameContractManager.setEscrowUnwindDeps({
            blockchainMonitor: this._blockchainMonitor
        });

        this._setupSessionLifecycle.setEscrowUnwindBridgeDeps({
            paymentSessionManager: this._paymentSessionManager
        });

        this._logger.startupLine("ContractSettlementManager");

        this._tonFinancialRecovery = new TonFinancialRecovery({
            logger: this._logger,
            eventBus: this._eventBus,
            sessionWalletStore: this._sessionWalletStore,
            paymentSessionManager: this._paymentSessionManager,
            gameContractManager: this._gameContractManager,
            contractSettlementManager: this._contractSettlementManager,
            blockchainMonitor: this._blockchainMonitor,
            playerManager: this._managers.playerManager,
            roomManager: this._managers.roomManager,
            financialPersistence: this._financialPersistence
        });

        this._tonFinancialRecovery.initialize();

        await this._tonFinancialRecovery.recover({
            trigger: "server_restart",
            reason: "application_startup"
        });

        this._logger.startupLine("TonFinancialRecovery");

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
            contractSettlementManager: this._contractSettlementManager,
            sessionWalletStore: this._sessionWalletStore,
            isDevelopment: this._productionConfig.isDevelopment,
            lifecycleManager: this._lifecycleManager,
            roomConfig: this._roomConfig
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
            roomLobbyBridge: this._roomLobbyBridge,
            resultSessionLifecycle: this._resultSessionLifecycle
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

        // R6.0C — Developer Console read-only projection layer (/console/*).
        this._consoleProjectionService = new DeveloperConsoleProjectionService({
            roomManager: this._managers.roomManager,
            gameManager: this._managers.gameManager,
            playerManager: this._managers.playerManager,
            setupSessionLifecycle: this._setupSessionLifecycle,
            paymentSessionManager: this._paymentSessionManager,
            gameContractManager: this._gameContractManager,
            contractSettlementManager: this._contractSettlementManager,
            gameStartAuthorization: this._gameStartAuthorization,
            resultSessionLifecycle: this._resultSessionLifecycle,
            recoveryEngine: this._recoveryEngine,
            recoverySnapshotCache: this._recoverySnapshotCache,
            simulationLoop: this._simulationLoop,
            physicsEngine: this._engines.physicsEngine,
            gameStateEngine: this._engines.gameStateEngine,
            gameClockEngine: this._engines.gameClockEngine,
            winnerEngine: this._engines.winnerEngine,
            socketGateway: this._socketGateway,
            metricsService: this._metricsService,
            healthService: this._healthService,
            lifecycleManager: this._lifecycleManager,
            gameplayContextResolver: this._gameplayContextResolver,
            runtimeConfig: this._runtimeConfig,
            tonService: this._services?.tonService ?? null,
            blockchainMonitor: this._blockchainMonitor,
            walletManager: null,
            tonFinancialRecovery: this._tonFinancialRecovery,
            roomLobbyBridge: this._roomLobbyBridge,
            startedAt: this._serverStartedAt
        });

        // R7.0 — Immutable session lifecycle history (observe-only archive).
        this._sessionHistoryArchive = SessionHistoryArchiveManager.getInstance();

        this._sessionHistoryArchive.initialize({
            eventBus: this._eventBus,
            projectionService: this._consoleProjectionService,
            roomLobbyBridge: this._roomLobbyBridge,
            playerManager: this._managers.playerManager,
            loggingManager: LoggingManager.getInstance()
        });

        this._sessionHistoryArchive.rebuildIndexFromDisk();

        this._logger.startupLine("SessionHistoryArchiveManager");

        // R13.9H — Forensic lifecycle archive (collect → ZIP → private Cloudflare R2).
        const forensicArchiveConfig = resolveForensicArchiveConfig();

        const forensicArchiveUploader = new R2ForensicArchiveUploader({
            logger: this._logger,
            bucket: forensicArchiveConfig.bucket,
            prefix: forensicArchiveConfig.prefix,
            endpoint: forensicArchiveConfig.endpoint,
            accessKeyId: forensicArchiveConfig.accessKeyId,
            secretAccessKey: forensicArchiveConfig.secretAccessKey,
            accountId: forensicArchiveConfig.accountId
        });

        this._forensicArchiveService = new ForensicArchiveService({
            logger: this._logger,
            config: forensicArchiveConfig,
            uploader: forensicArchiveUploader,
            sessionHistoryArchive: this._sessionHistoryArchive,
            financialPersistence: this._financialPersistence
        });

        this._roomLobbyBridge.configureForensicArchiveService(
            this._forensicArchiveService
        );

        this._logger.startupLine("ForensicArchiveService");
        this._logger.info(
            `R2_FORENSIC_ARCHIVE_ENABLED | configured=${forensicArchiveUploader.isConfigured()}`
            + ` | required=${forensicArchiveConfig.required === true}`
            + ` | bucket=${forensicArchiveConfig.bucket ? "set" : "unset"}`
        );

        // R6.1 / R7.0C — Secure Developer Access from immutable runtime config.
        this._developerAuthService = new DeveloperAuthService({
            config: this._runtimeConfig.developer,
            logger: this._logger
        });

        registerDeveloperAuthRoutes(
            this._expressApp,
            this._developerAuthService
        );

        this._appEnvironmentService = new AppEnvironmentService({
            developerConfig: this._runtimeConfig.developer,
            logger: this._logger
        });

        registerEnvironmentControlRoutes(this._expressApp, {
            authService: this._developerAuthService,
            environmentService: this._appEnvironmentService
        });

        this._maintenanceService = new MaintenanceService({
            logger: this._logger
        });

        registerMaintenanceRoutes(this._expressApp, {
            authService: this._developerAuthService,
            maintenanceService: this._maintenanceService
        });

        // R14.3 — Advertisement Manager API (console-only; isolated from gameplay).
        this._advertisementManager = new AdvertisementManager({
            logger: this._logger
        });

        this._advertisementManager.initialize();

        const advertisementR2Config = resolveAdvertisementR2Config();

        this._logger.info(
            "ADVERTISEMENT_STORAGE"
            + ` | backend=${advertisementR2Config.useR2 ? "r2" : "local"}`
            + ` | r2Configured=${advertisementR2Config.r2Configured === true}`
            + ` | dataDir=${this._advertisementManager.getDataDir()}`
        );

        this._advertisementHistoryService = new AdvertisementHistoryService({
            logger: this._logger,
            historyDir: this._advertisementManager.getHistoryDir()
        });

        this._advertisementHistoryService.initialize();

        this._advertisementRedirectService = new AdvertisementRedirectService({
            logger: this._logger,
            advertisementManager: this._advertisementManager,
            historyService: this._advertisementHistoryService
        });

        this._advertisementRedirectService.initialize();

        this._logger.startupLine("AdvertisementManager");
        this._logger.startupLine("AdvertisementHistoryService");
        this._logger.startupLine("AdvertisementRedirectService");

        // R14.7 — Campaign expiration → WAITING_OWNER_RENEWAL (scheduler-driven).
        this._advertisementLifecycleManager = new AdvertisementLifecycleManager({
            logger: this._logger,
            advertisementManager: this._advertisementManager
        });

        this._advertisementLifecycleManager.initialize();

        // R14.4 / R14.6 — Scheduler + impression confirmation after full slot.
        this._advertisementSelectionEngine = new AdvertisementSelectionEngine({
            advertisementManager: this._advertisementManager
        });

        this._advertisementScheduler = new AdvertisementScheduler({
            logger: this._logger,
            eventBus: this._eventBus,
            selectionEngine: this._advertisementSelectionEngine,
            lifecycleManager: this._advertisementLifecycleManager,
            historyService: this._advertisementHistoryService
        });

        this._advertisementScheduler.initialize();
        this._advertisementScheduler.start();

        this._socketGateway.configureAdvertisementScheduler(
            this._advertisementScheduler
        );

        registerAdvertisementRoutes(this._expressApp, {
            authService: this._developerAuthService,
            advertisementManager: this._advertisementManager,
            advertisementRedirectService: this._advertisementRedirectService,
            advertisementScheduler: this._advertisementScheduler
        });

        this._logger.startupLine("AdvertisementLifecycleManager");
        this._logger.startupLine("AdvertisementScheduler");

        registerDeveloperConsoleRoutes(
            this._expressApp,
            this._consoleProjectionService,
            {
                authMiddleware: createDeveloperAuthMiddleware(
                    this._developerAuthService
                ),
                authService: this._developerAuthService,
                gameDiagnosticLogManager: this._gameDiagnosticLogManager,
                sessionHistoryArchive: this._sessionHistoryArchive
            }
        );

        this._consoleGateway = new DeveloperConsoleGateway({
            logger: this._logger,
            io: this._socketGateway.getIO(),
            projectionService: this._consoleProjectionService,
            eventBus: this._eventBus,
            authService: this._developerAuthService,
            loggingManager: LoggingManager.getInstance()
        });

        this._consoleGateway.initialize();

        this._logger.startupLine("DeveloperConsoleProjectionService");

        this._logger.startupLine("DeveloperConsoleGateway");

        this._logger.startupLine(
            this._developerAuthService.allowsOpenAccess()
                ? "DeveloperAuthService (open access)"
                : this._developerAuthService.isEnabled()
                    ? "DeveloperAuthService (enabled)"
                    : "DeveloperAuthService (login required; not fully configured)"
        );

        // R7.0E — observational monitoring (after providers exist).
        this._startMonitoring();

        // R7.0G — deployment health / readiness / liveness probes.
        this._startDeploymentHealth();

        await this._listen();

        const startupDurationMs = performance.now() - this._startupStartedAt;

        this._metricsService.record("startup.total", startupDurationMs);

        this._healthService.markStartupComplete(
            Number(startupDurationMs.toFixed(3))
        );

        this._lifecycleManager.markRunning();

        this._deploymentManager?.getHealthManager?.()?.refresh?.();

        const healthSnapshot = this._healthService.getHealthSnapshot();

        this._healthService.logStartupSummary(healthSnapshot);

        LoggingManager.getInstance().write({
            level: LOG_LEVELS.INFO,
            service: "wheelwin-deployment-health",
            message: "Startup complete",
            fields: {
                profile: this._deploymentManager?.getProfile?.()?.name ?? null,
                durationMs: Number(startupDurationMs.toFixed(3)),
                startup: healthSnapshot.probes?.startup?.ok === true,
                ready: healthSnapshot.ready === true
            }
        });

        this._logger.info("");
        this._logger.info("Server Ready");
        this._logger.info("");

        if (this._productionConfig.runStartupDemonstrations) {

            this._runStartupDemonstrations();

        }

        this._registerShutdownHandlers();

    }

    /**
     * R7.0B — Graceful shutdown: RUNNING → DRAINING → teardown → STOPPED.
     * Drain rejects new rooms/setup while allowing in-flight work to finish.
     * SERVER_SHUTDOWN is emitted only after the drain wait (or timeout).
     *
     * @param {{ reason?: string }} [options]
     */
    async shutdown({ reason = "application_shutdown" } = {}) {

        if (this._isShuttingDown) {

            return;

        }

        this._isShuttingDown = true;

        this._logger.info("");
        this._logger.info("Stopping WheelWin Server...");
        this._logger.info("");

        const drainResult = await this._lifecycleManager.beginDrain({ reason });

        if (drainResult.forced) {

            this._logger.warn(
                `Forced shutdown after drain timeout | durationMs=${drainResult.durationMs}`
            );

        } else {

            this._logger.info(
                `Drain complete | durationMs=${drainResult.durationMs}`
            );

        }

        // Tear down authoritative components only after drain. Console stayed
        // available throughout DRAINING via HTTP + /console gateway.
        if (this._eventBus) {

            this._eventBus.emit({
                source: EVENT_SOURCES.APPLICATION,
                type: EVENT_TYPES.SERVER_SHUTDOWN,
                payload: {
                    reason,
                    forced: drainResult.forced === true,
                    drainDurationMs: drainResult.durationMs
                }
            });

        }

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

        this._safeShutdownStep("sessionHistoryArchive", () => {

            if (this._sessionHistoryArchive) {

                this._sessionHistoryArchive.shutdown();

            }

        });

        this._safeShutdownStep("gameDiagnosticLogManager", () => {

            if (this._gameDiagnosticLogManager) {

                this._gameDiagnosticLogManager.shutdown();

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

        this._safeShutdownStep("deploymentCostService", () => {

            if (this._deploymentCostService) {

                this._deploymentCostService.shutdown();

            }

        });

        this._safeShutdownStep("deploymentReimbursementWorker", () => {

            if (this._deploymentReimbursementWorker) {

                this._deploymentReimbursementWorker.shutdown();

            }

        });

        this._safeShutdownStep("deploymentReimbursementService", () => {

            if (this._deploymentReimbursementService) {

                this._deploymentReimbursementService.shutdown();

            }

        });

        this._safeShutdownStep("gameStartAuthorization", () => {

            if (this._gameStartAuthorization) {

                this._gameStartAuthorization.shutdown();

            }

        });

        this._safeShutdownStep("contractSettlementManager", () => {

            if (this._contractSettlementManager) {

                this._contractSettlementManager.shutdown();

            }

        });

        this._safeShutdownStep("financialPersistence", () => {

            if (this._financialPersistence) {

                this._financialPersistence.shutdown({ checkpoint: true });

            }

        });

        this._safeShutdownStep("developerAuthService", () => {

            if (this._developerAuthService) {

                this._developerAuthService.shutdown();

            }

        });

        this._safeShutdownStep("advertisementScheduler", () => {

            if (this._advertisementScheduler) {

                this._advertisementScheduler.shutdown();

            }

        });

        this._safeShutdownStep("advertisementLifecycleManager", () => {

            if (this._advertisementLifecycleManager) {

                this._advertisementLifecycleManager.shutdown();

            }

        });

        this._safeShutdownStep("advertisementRedirectService", () => {

            if (this._advertisementRedirectService) {

                this._advertisementRedirectService.shutdown();

            }

        });

        this._safeShutdownStep("consoleGateway", () => {

            if (this._consoleGateway) {

                this._consoleGateway.shutdown();

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

        await this._safeShutdownStep("httpServer", () => this._closeHttpServer());

        this._safeShutdownStep("eventBus", () => {

            this._shutdownEventBus();

        });

        this._safeShutdownStep("services", () => {

            this._shutdownServices();

        });

        this._lifecycleManager.markStopped({ forced: drainResult.forced });

        LoggingManager.getInstance().audit("shutdown complete", {
            lifecycleState: "STOPPED",
            forced: drainResult.forced === true,
            durationMs: drainResult.durationMs
        });

        this._logger.info(
            `Shutdown complete. | durationMs=${drainResult.durationMs} | forced=${drainResult.forced}`
        );

        LoggingManager.getInstance().flushSync();

        LoggingManager.getInstance().shutdown();

        if (this._monitoringManager) {

            this._monitoringManager.shutdown();

            this._monitoringManager = null;

        }

        if (this._failurePolicyManager) {

            this._failurePolicyManager.shutdown();

            this._failurePolicyManager = null;

        }

        if (this._deploymentManager) {

            this._deploymentManager.shutdown();

            this._deploymentManager = null;

        }

        if (this._releaseManager) {

            this._releaseManager = null;

        }

        if (this._certificationManager) {

            this._certificationManager = null;

        }

        if (this._closedBetaManager) {

            this._closedBetaManager.shutdown();

            this._closedBetaManager = null;

        }

        if (this._launchReadinessManager) {

            this._launchReadinessManager = null;

        }

        if (this._generalAvailabilityManager) {

            this._generalAvailabilityManager = null;

        }

        if (this._operationsManager) {

            this._operationsManager = null;

        }

        if (this._governanceManager) {

            this._governanceManager = null;

        }

        if (this._prometheusServer) {

            try {

                this._prometheusServer.close();

            } catch {

                // ignore
            }

            this._prometheusServer = null;

        }

    }

    /**
     * R7.0E — Start observational monitoring collectors.
     */
    _startMonitoring() {

        const monitoringConfig = this._productionConfig.monitoring ?? {
            enabled: true,
            intervals: {},
            prometheusEnabled: false
        };

        this._monitoringManager = MonitoringManager.getInstance();

        this._monitoringManager.initialize({
            enabled: monitoringConfig.enabled !== false,
            intervals: monitoringConfig.intervals ?? {},
            prometheusEnabled: monitoringConfig.prometheusEnabled === true,
            providers: {
                roomManager: this._managers?.roomManager,
                gameManager: this._managers?.gameManager,
                playerManager: this._managers?.playerManager,
                setupSessionLifecycle: this._setupSessionLifecycle,
                resultSessionLifecycle: this._resultSessionLifecycle,
                paymentSessionManager: this._paymentSessionManager,
                paymentEngine: this._engines?.paymentEngine,
                contractSettlementManager: this._contractSettlementManager,
                recoveryEngine: this._recoveryEngine,
                simulationLoop: this._simulationLoop,
                physicsEngine: this._engines?.physicsEngine,
                metricsService: this._metricsService,
                socketGateway: this._socketGateway,
                consoleGateway: this._consoleGateway,
                loggingManager: LoggingManager.getInstance(),
                failurePolicy: this._failurePolicyManager,
                deploymentHealth: {
                    getSafeStatus: () => this._deploymentManager
                        ?.getHealthManager?.()
                        ?.getSafeStatus?.() ?? null
                },
                releaseManager: this._releaseManager,
                certificationManager: this._certificationManager,
                closedBetaManager: this._closedBetaManager,
                launchReadinessManager: this._launchReadinessManager,
                generalAvailabilityManager: this._generalAvailabilityManager,
                operationsManager: this._operationsManager,
                governanceManager: this._governanceManager,
                httpStats: () => ({ ...this._httpStats }),
                lifecycleState: () => this._lifecycleManager?.getState?.() ?? null,
                environment: () => this._serverConfig?.nodeEnv ?? null,
                profile: () => this._runtimeConfig?.profile ?? null,
                version: () => this._runtimeConfig?.version ?? null
            }
        });

        this._healthService.setMonitoringStatus(
            this._monitoringManager.getHealthStatus()
        );

        if (this._closedBetaManager) {

            this._closedBetaManager.updateProviders({
                metricsService: this._metricsService,
                monitoringManager: this._monitoringManager,
                monitoringSnapshot: () => this._monitoringManager?.getSnapshot?.()
                    ?? null,
                releaseManager: this._releaseManager,
                certificationManager: this._certificationManager,
                gameManager: this._managers?.gameManager,
                environment: () => this._serverConfig?.nodeEnv ?? null,
                profile: () => this._runtimeConfig?.profile ?? null,
                version: () => this._runtimeConfig?.version ?? null
            });

            this._healthService.setClosedBetaStatus(
                this._closedBetaManager.getSafeStatus()
            );

        }

        if (this._launchReadinessManager) {

            this._launchReadinessManager.updateProviders({
                closedBetaManager: this._closedBetaManager,
                certificationManager: this._certificationManager,
                releaseManager: this._releaseManager,
                monitoringManager: this._monitoringManager,
                healthSnapshot: () => this._healthService.getHealthSnapshot(),
                deploymentHealth: () => this._deploymentManager
                    ?.getHealthManager?.()
                    ?.getSafeStatus?.() ?? null,
                tonConfig: () => this._runtimeConfig?.ton ?? null,
                safeConfiguration: () => this._runtimeConfig?.toSafeSummary?.()
                    ?? null,
                logging: () => LoggingManager.getInstance().getSafeStatus(),
                failurePolicy: () => this._failurePolicyManager?.getSafeStatus?.()
                    ?? null,
                developerConsole: () => ({
                    enabled: this._developerAuthService?.isEnabled?.() === true
                }),
                version: () => this._runtimeConfig?.version ?? null
            });

            this._healthService.setLaunchStatus(
                this._launchReadinessManager.getSafeStatus()
            );

        }

        if (this._generalAvailabilityManager) {

            this._generalAvailabilityManager.updateProviders({
                closedBetaManager: this._closedBetaManager,
                launchReadinessManager: this._launchReadinessManager,
                certificationManager: this._certificationManager,
                releaseManager: this._releaseManager,
                monitoringManager: this._monitoringManager,
                healthSnapshot: () => this._healthService.getHealthSnapshot(),
                deploymentHealth: () => this._deploymentManager
                    ?.getHealthManager?.()
                    ?.getSafeStatus?.() ?? null,
                tonConfig: () => this._runtimeConfig?.ton ?? null,
                safeConfiguration: () => this._runtimeConfig?.toSafeSummary?.()
                    ?? null,
                logging: () => LoggingManager.getInstance().getSafeStatus(),
                failurePolicy: () => this._failurePolicyManager?.getSafeStatus?.()
                    ?? null,
                developerConsole: () => ({
                    enabled: this._developerAuthService?.isEnabled?.() === true
                }),
                version: () => this._runtimeConfig?.version ?? null
            });

            this._healthService.setGaStatus(
                this._generalAvailabilityManager.getSafeStatus()
            );

        }

        if (this._operationsManager) {

            this._operationsManager.updateProviders({
                metricsService: this._metricsService,
                monitoringManager: this._monitoringManager,
                healthSnapshot: () => this._healthService.getHealthSnapshot(),
                deploymentHealth: () => this._deploymentManager
                    ?.getHealthManager?.()
                    ?.getSafeStatus?.() ?? null,
                closedBetaManager: this._closedBetaManager,
                generalAvailabilityManager: this._generalAvailabilityManager,
                releaseManager: this._releaseManager,
                gameManager: this._managers?.gameManager,
                version: () => this._runtimeConfig?.version ?? null
            });

            this._healthService.setOperationsStatus(
                this._operationsManager.getSafeStatus()
            );

        }

        if (this._governanceManager) {

            this._governanceManager.updateProviders({
                metricsService: this._metricsService,
                monitoringManager: this._monitoringManager,
                healthSnapshot: () => this._healthService.getHealthSnapshot(),
                deploymentHealth: () => this._deploymentManager
                    ?.getHealthManager?.()
                    ?.getSafeStatus?.() ?? null,
                operationsManager: this._operationsManager,
                closedBetaManager: this._closedBetaManager,
                generalAvailabilityManager: this._generalAvailabilityManager,
                releaseManager: this._releaseManager,
                certificationManager: this._certificationManager,
                failurePolicy: () => this._failurePolicyManager
                    ?.getSafeStatus?.() ?? null,
                safeConfiguration: () => this._runtimeConfig
                    ?.toSafeSummary?.() ?? null,
                developerConsole: () => ({
                    enabled: this._developerAuthService?.isEnabled?.() === true
                }),
                tonConfig: () => this._runtimeConfig?.ton
                    ? {
                        network: this._runtimeConfig.ton.network ?? null,
                        deployMode: this._runtimeConfig.ton.deployMode ?? null
                    }
                    : null,
                version: () => this._runtimeConfig?.version ?? null
            });

            this._healthService.setGovernanceStatus(
                this._governanceManager.getSafeStatus()
            );

        }

        this._logger.startupLine(
            monitoringConfig.enabled === false
                ? "MonitoringManager (disabled)"
                : "MonitoringManager"
        );

        if (monitoringConfig.prometheusEnabled
            && monitoringConfig.prometheusPort
            && monitoringConfig.prometheusPort !== this._serverConfig.port) {

            this._startPrometheusSidecar(monitoringConfig);

        }

    }

    /**
     * R7.0G — Deployment health / readiness / liveness probe subsystem.
     */
    _startDeploymentHealth() {

        const deploymentConfig = this._productionConfig.deployment ?? {
            profile: this._runtimeConfig?.profile ?? "development",
            healthEnabled: true,
            readinessEnabled: true,
            livenessEnabled: true,
            startupEnabled: true
        };

        this._deploymentManager = DeploymentManager.getInstance();

        this._deploymentManager.initialize({
            deployment: deploymentConfig,
            providers: {
                lifecycleState: () => this._lifecycleManager?.getState?.() ?? null,
                lifecycleInitialized: () => this._lifecycleManager != null,
                configurationLoaded: () => this._runtimeConfig != null,
                loggingActive: () => LoggingManager.getInstance().isInitialized(),
                monitoringInitialized: () => this._monitoringManager != null,
                monitoringActive: () => this._monitoringManager?.isRunning?.() === true,
                monitoringRequired: () =>
                    this._productionConfig?.monitoring?.enabled !== false,
                failurePolicyInitialized: () => this._failurePolicyManager != null,
                httpListening: () => this._httpServer?.listening === true,
                socketListening: () => this._httpServer?.listening === true
                    && this._socketGateway?.getIO?.() != null,
                eventLoopDelayMs: () => {
                    const snap = this._monitoringManager?.getSnapshot?.();
                    return snap?.runtime?.eventLoopDelayMs ?? null;
                },
                activeGames: () =>
                    this._managers?.gameManager?.getGames?.()?.length ?? 0,
                activeRooms: () =>
                    this._managers?.roomManager?.getRooms?.()?.length ?? 0,
                memory: () => process.memoryUsage()
            }
        });

        const healthManager = this._deploymentManager.getHealthManager();

        this._healthService.setHealthManager(healthManager);

        this._logger.startupLine(
            deploymentConfig.healthEnabled === false
                ? "DeploymentManager (disabled)"
                : `DeploymentManager (${deploymentConfig.profile})`
        );

        LoggingManager.getInstance().write({
            level: LOG_LEVELS.INFO,
            service: "wheelwin-deployment-health",
            message: "Deployment profile",
            fields: {
                profile: this._deploymentManager.getProfile()?.name ?? null
            }
        });

    }

    _startPrometheusSidecar(monitoringConfig) {

        const sidecar = express();

        sidecar.get(monitoringConfig.prometheusPath || "/metrics", (req, res) => {

            if (!this._monitoringManager?.isPrometheusEnabled?.()) {

                res.status(404).end();

                return;

            }

            res.set("Content-Type", "text/plain; version=0.0.4; charset=utf-8");

            res.send(this._monitoringManager.getPrometheusText());

        });

        this._prometheusServer = http.createServer(sidecar);

        this._prometheusServer.listen(
            monitoringConfig.prometheusPort,
            this._serverConfig.host
        );

        this._logger.info(
            `Prometheus sidecar listening | port=${monitoringConfig.prometheusPort} path=${monitoringConfig.prometheusPath}`
        );

    }

    /**
     * R7.0B — In-flight work counts for drain wait (read-only).
     */
    _collectDrainActivity() {

        return {
            setupSessions:
                this._setupSessionLifecycle?.getActiveSessionCount?.() ?? 0,
            activeGames: this._managers?.gameManager?.getGames?.().length ?? 0,
            paymentSessions:
                this._paymentSessionManager?.getActiveSessionCount?.() ?? 0,
            pendingPayments:
                this._engines?.paymentEngine?.getActivePaymentCount?.() ?? 0,
            settlements:
                this._contractSettlementManager?.getActiveSettlementCount?.()
                    ?? 0,
            pendingTeardowns:
                this._gameplayLifecycle?.getPendingTeardownCount?.() ?? 0,
            activeSimulations:
                this._engines?.physicsEngine?.getActiveSimulationCount?.() ?? 0,
            recoverySessions:
                this._recoveryEngine?.listActiveRecoveryGameIds?.()?.length
                    ?? 0,
            resultSessions:
                this._resultSessionLifecycle?.getActiveSessionCount?.() ?? 0
        };

    }

    /**
     * C4.5 — Live runtime counts pulled from existing engine/service accessors.
     * Read-only: it never mutates state and is safe to call on every /health hit.
     */
    _collectRuntime() {

        // Re-entrancy guard: getHealthSnapshot() → runtime provider must not
        // call getSafeStatus() paths that themselves request a health snapshot
        // (launch / GA / ops / governance evaluate via healthSnapshot).
        if (this._collectingRuntime) {

            const drain = this._lifecycleManager?.getSnapshot?.() ?? null;

        return {
            activeRooms: this._managers?.roomManager?.getRooms?.().length ?? 0,
            activeGames: this._managers?.gameManager?.getGames?.().length ?? 0,
            activeSimulations:
                    this._engines?.physicsEngine?.getActiveSimulationCount?.()
                        ?? 0,
            activeTimers:
                    this._engines?.gameClockEngine?.getActiveClockCount?.()
                        ?? 0,
            activeSockets:
                this._socketGateway?.getConnectedSocketCount?.() ?? 0,
            pendingTeardowns:
                this._gameplayLifecycle?.getPendingTeardownCount?.() ?? 0,
            pendingPayments:
                    this._engines?.paymentEngine?.getActivePaymentCount?.()
                        ?? 0,
            pendingAudits:
                    this._auditEngine?.getActiveAuditCount?.() ?? 0,
                lifecycle: drain?.state ?? null,
                ready: drain?.ready ?? null,
                drainActivity: drain?.activity ?? null,
                monitoring: this._monitoringManager?.getSnapshot?.()
                    ?.toSafeSummary?.() ?? null
            };

        }

        this._collectingRuntime = true;

        try {

            const drain = this._lifecycleManager?.getSnapshot?.() ?? null;

            if (this._monitoringManager) {

                this._healthService.setMonitoringStatus(
                    this._monitoringManager.getHealthStatus()
                );

            }

            if (this._failurePolicyManager) {

                this._healthService.setFailurePolicyStatus(
                    this._failurePolicyManager.getSafeStatus()
                );

            }

            if (this._releaseManager) {

                this._healthService.setReleaseStatus(
                    this._releaseManager.getSafeStatus()
                );

            }

            if (this._certificationManager) {

                this._healthService.setCertificationStatus(
                    this._certificationManager.getSafeStatus()
                );

            }

            if (this._closedBetaManager) {

                this._healthService.setClosedBetaStatus(
                    this._closedBetaManager.getSafeStatus()
                );

            }

            if (this._launchReadinessManager) {

                this._healthService.setLaunchStatus(
                    this._launchReadinessManager.getSafeStatus()
                );

            }

            if (this._generalAvailabilityManager) {

                this._healthService.setGaStatus(
                    this._generalAvailabilityManager.getSafeStatus()
                );

            }

            if (this._operationsManager) {

                this._healthService.setOperationsStatus(
                    this._operationsManager.getSafeStatus()
                );

            }

            if (this._governanceManager) {

                this._healthService.setGovernanceStatus(
                    this._governanceManager.getSafeStatus()
                );

            }

            return {
                activeRooms: this._managers?.roomManager?.getRooms?.().length ?? 0,
                activeGames: this._managers?.gameManager?.getGames?.().length ?? 0,
                activeSimulations:
                    this._engines?.physicsEngine?.getActiveSimulationCount?.()
                        ?? 0,
                activeTimers:
                    this._engines?.gameClockEngine?.getActiveClockCount?.()
                        ?? 0,
                activeSockets:
                    this._socketGateway?.getConnectedSocketCount?.() ?? 0,
                pendingTeardowns:
                    this._gameplayLifecycle?.getPendingTeardownCount?.() ?? 0,
                pendingPayments:
                    this._engines?.paymentEngine?.getActivePaymentCount?.()
                        ?? 0,
                pendingAudits:
                    this._auditEngine?.getActiveAuditCount?.() ?? 0,
                lifecycle: drain?.state ?? null,
                ready: drain?.ready ?? null,
                drainActivity: drain?.activity ?? null,
                monitoring: this._monitoringManager?.getSnapshot?.()
                    ?.toSafeSummary?.() ?? null
            };

        } finally {

            this._collectingRuntime = false;

        }

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

        // R7.67A — surface active escrow mode at startup (v4 | game).
        this._logger.startupLine(
            `GameEscrowMode=${this._tonConfig?.gameEscrowMode ?? "unknown"} `
                + `(network=${this._tonConfig?.network ?? "unknown"})`
        );

        // R7.70A.2 — Testnet oracle diagnostics (public address only).
        if ((this._tonConfig?.network ?? "").toLowerCase() === "testnet") {

            const oracleAddress = this._tonConfig?.oracleAddress ?? null;
            const oracleSource = this._tonConfig?.oracleSource ?? null;

            setTonTestnetOracleDebug({
                network: "testnet",
                oracleConfigured: Boolean(oracleAddress),
                oracleAddress,
                oracleSource,
                timestamp: Date.now()
            });
            printTonTestnetOracleDebug();

            this._logger.startupLine(
                `TonTestnetOracle configured=${Boolean(oracleAddress)} `
                    + `source=${oracleSource ?? "none"} `
                    + `address=${oracleAddress ?? "null"}`
            );

        }

    }

    /**
     * R7.70B — Print R7.70 WALLET READINESS (read-only; no on-chain mutations).
     */
    async _runTonTestnetWalletReadinessDiagnostics() {

        if ((this._tonConfig?.network ?? "").toLowerCase() !== "testnet") {

            return;

        }

        let deployAddress = null;
        let deployWalletId = null;
        let deployBalanceTon = null;
        let ownerAddress = null;
        let ownerBalanceTon = null;

        try {

            const mnemonic = this._tonConfig?.deployerMnemonic;

            if (mnemonic) {

                const identity = await deriveDeployerWalletIdentity({
                    mnemonic,
                    network: "testnet"
                });

                deployAddress = identity.address;
                deployWalletId = identity.walletId;

                try {

                    const nano = await this._services.tonService.getBalance(
                        identity.address
                    );

                    deployBalanceTon = Number(nano) / 1e9;

                } catch {

                    deployBalanceTon = null;

                }

            }

        } catch {

            // identity probe best-effort
        }

        try {

            if (OwnerConfiguration.isLoaded()) {

                ownerAddress = OwnerConfiguration.getOwnerWallet();

                try {

                    const nano = await this._services.tonService.getBalance(
                        ownerAddress
                    );

                    ownerBalanceTon = Number(nano) / 1e9;

                } catch {

                    ownerBalanceTon = null;

                }

            }

        } catch {

            ownerAddress = null;

        }

        const walletReadiness = evaluateTonTestnetWalletReadiness({
            network: this._tonConfig?.network,
            gameEscrowMode: this._tonConfig?.gameEscrowMode,
            deployAddress,
            deployWalletId,
            deployBalanceTon,
            oracleAddress: this._tonConfig?.oracleAddress ?? null,
            oracleSource: this._tonConfig?.oracleSource ?? null,
            ownerAddress,
            ownerBalanceTon
        });

        setTonTestnetWalletReadiness(walletReadiness);
        printTonTestnetWalletReadiness(walletReadiness);

        this._logger.startupLine(
            `R770WalletReadiness=${walletReadiness.status} `
                + `stake=${walletReadiness.stakeGram}Gram `
                + `mode=${walletReadiness.mode}`
        );

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

    /**
     * R7.67B — Derive WalletContractV4R2 identity, log TON_WALLET_IDENTITY_DEBUG,
     * check balance, and fail startup if derived address ≠ expected pin.
     * Never logs mnemonic. Does not change wallet type or payment/GameEscrow paths.
     */
    async _runTonWalletIdentityDiagnostics() {

        const mnemonic = this._tonConfig?.deployerMnemonic;
        const network = this._tonConfig?.network ?? null;
        const expectedAddress = this._tonConfig?.deployerExpectedAddress ?? null;

        if (!mnemonic || typeof mnemonic !== "string") {

            setTonWalletIdentityDebug({
                mnemonicConfigured: false,
                network,
                expectedAddress,
                identityMatch: null,
                lastCheckedAt: null
            });
            printTonWalletIdentityDebug();
            this._logger.startupLine(
                "TonWalletIdentity (mnemonic not configured)"
            );

            return;

        }

        const identity = await deriveDeployerWalletIdentity({
            mnemonic,
            network
        });

        const lastCheckedAt = Date.now();
        let balanceNano = null;
        let balanceTon = null;
        let balanceError = null;

        try {

            const nano = await this._services.tonService.getBalance(
                identity.address
            );

            balanceNano = String(nano);
            balanceTon = Number(nano) / 1e9;

        } catch (error) {

            balanceError = error?.message ?? String(error);

        }

        const identityMatch = expectedAddress
            ? tonAddressesEqual(identity.address, expectedAddress)
            : null;

        setTonWalletIdentityDebug({
            walletContractType: identity.walletContractType,
            workchain: identity.workchain,
            walletId: identity.walletId,
            address: identity.address,
            network: identity.network,
            balanceTon,
            balanceNano,
            lastCheckedAt,
            expectedAddress,
            identityMatch,
            mnemonicConfigured: true,
            balanceError
        });
        printTonWalletIdentityDebug();

        this._logger.info(
            `TON wallet balance | address=${identity.address} | `
                + `balanceTon=${balanceTon ?? "n/a"} | `
                + `lastCheckedAt=${new Date(lastCheckedAt).toISOString()}`
        );

        this._logger.startupLine(
            `TonWalletIdentity=${identity.walletContractType} `
                + `walletId=${identity.walletId} `
                + `address=${identity.address}`
        );

        assertDeployerWalletMatchesExpected(identity.address, expectedAddress, {
            network
        });

    }

    /**
     * R7.68 / R8.1A / R8.1B — Print TON_MAINNET_READINESS and fail-fast when active network is mainnet.
     * Testnet runtime stays unchanged (report may FAIL until mainnet env is filled).
     * Does not enable Mainnet GameEscrow gameplay.
     */
    async _runTonMainnetReadinessDiagnostics() {

        const network = this._tonConfig?.network ?? null;
        const mnemonic = this._tonConfig?.deployerMnemonic;
        const mainnetProfile = this._tonConfig?.profiles?.mainnet ?? null;

        let walletType = null;
        let workchain = null;
        let walletId = null;
        let walletAddress = null;
        let balanceTon = null;
        let balanceNano = null;
        let seqno = null;

        if (mnemonic && typeof mnemonic === "string") {

            try {

                const identity = await deriveDeployerWalletIdentity({
                    mnemonic,
                    network
                });

                walletType = identity.walletContractType;
                workchain = identity.workchain;
                walletId = identity.walletId;
                walletAddress = identity.address;

                try {

                    const nano = await this._services.tonService.getBalance(
                        identity.address
                    );

                    balanceNano = String(nano);
                    balanceTon = Number(nano) / 1e9;

                } catch {

                    balanceTon = null;
                    balanceNano = null;

                }

                try {

                    seqno = await this._services.tonService.getSeqno(
                        identity.address
                    );

                } catch {

                    seqno = null;

                }

            } catch (error) {

                this._logger?.warn?.(
                    `Mainnet readiness wallet probe skipped | ${error?.message ?? error}`
                );

            }

        }

        const artifact = verifyGameEscrowArtifact({
            expectedSha256: this._tonConfig?.artifactSha256Expected
                ?? mainnetProfile?.artifactSha256
                ?? null,
            requirePresent: network === "mainnet"
                || this._tonConfig?.gameEscrowMode === "game",
            requireLoadable: network === "mainnet"
                || this._tonConfig?.gameEscrowMode === "game"
        });

        // Integrity: when an expected hash is known, mismatch fails on any network.
        if (artifact.expectedSha256 && artifact.present && artifact.match === false) {

            throw new Error(artifact.reasons[0] ?? "GameEscrow artifact SHA256 mismatch");

        }

        if (
            (network === "mainnet" || this._tonConfig?.gameEscrowMode === "game")
            && !artifact.present
        ) {

            throw new Error(
                artifact.reasons[0] ?? "GameEscrow artifact missing"
            );

        }

        if (
            (network === "mainnet" || this._tonConfig?.gameEscrowMode === "game")
            && artifact.loadable === false
        ) {

            throw new Error(
                artifact.reasons.find((reason) => reason.includes("loadable"))
                    ?? "GameEscrow artifact not loadable by StateInit builder"
            );

        }

        const readiness = evaluateMainnetReadiness({
            env: process.env,
            activeNetwork: network,
            walletType,
            workchain,
            walletId,
            walletAddress,
            balanceTon,
            balanceNano,
            seqno,
            requireLiveWallet: network === "mainnet"
        });

        setTonMainnetReadiness(readiness);
        printTonMainnetReadiness();
        printTonMainnetDryRunDebug(readiness);

        setTonMainnetWalletIdentityDebug({
            network: "mainnet",
            walletType: readiness.walletType,
            workchain: readiness.workchain,
            walletId: readiness.walletId,
            derivedAddress: readiness.walletAddress,
            expectedAddress: readiness.expectedAddress,
            oracleAddress: readiness.oracleAddress,
            identityMatch: readiness.identityMatch,
            balanceTon: readiness.balanceTon,
            balanceNano: readiness.balanceNano,
            seqno: readiness.seqno,
            timestamp: readiness.validationTimestamp
        });
        printTonMainnetWalletIdentityDebug();

        this._logger.startupLine(
            `TonMainnetReadiness=${readiness.status} `
                + `(active=${network ?? "unknown"} escrow=${readiness.escrowMode})`
        );

        if (network === "mainnet") {

            assertMainnetStartupSafe({
                profile: mainnetProfile ?? readiness.profile,
                walletAddress,
                walletType,
                workchain,
                walletId,
                artifact
            });

            if (readiness.status !== "PASS") {

                throw new Error(
                    `Mainnet startup validation failed: ${readiness.reasons.join("; ")}`
                );

            }

        }

    }

    /**
     * R7.62 / R7.67B — Derive deployer WalletContractV4R2 address for settlement tx watches.
     * Never logs mnemonic. Returns null when mnemonic is not configured.
     */
    async _resolveDeployerWalletAddress() {

        const mnemonic = this._tonConfig?.deployerMnemonic;

        if (!mnemonic || typeof mnemonic !== "string") {

            return null;

        }

        try {

            const identity = await deriveDeployerWalletIdentity({
                mnemonic,
                network: this._tonConfig?.network ?? null
            });

            return identity.address;

        } catch (error) {

            this._logger?.error?.(
                `Deployer wallet address resolve failed | ${error?.message ?? error}`
            );

            return null;

        }

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

        const trustProxy = process.env.TRUST_PROXY;

        if (trustProxy === "true") {

            app.set("trust proxy", 1);

        } else if (trustProxy && Number(trustProxy) > 0) {

            app.set("trust proxy", Number(trustProxy));

        }

        app.use(cors(this._serverConfig.cors));

        // R7.0E — observational HTTP counters (never mutate gameplay).
        app.use((req, res, next) => {

            const startedAt = performance.now();

            res.on("finish", () => {

                this._httpStats.requests += 1;

                this._httpStats.totalLatencyMs += performance.now() - startedAt;

                if (res.statusCode >= 500) {

                    this._httpStats.errors += 1;

                }

            });

            next();

        });

        // R6.11E — forensic unload beacon (own limit; before global 32kb).
        // Accepts text/plain (sendBeacon-safe) or JSON.
        app.post(
            "/api/diagnostics/tonconnect-autopsy",
            express.text({ type: "*/*", limit: "512kb" }),
            (req, res) => {

                try {

                    let body = req.body;

                    if (typeof body === "string") {

                        if (!body.trim()) {

                            res.status(400).json({
                                ok: false,
                                error: "empty body"
                            });

                            return;

                        }

                        body = JSON.parse(body);

                    }

                    const ok = this._roomLobbyBridge
                        ?.ingestTonConnectAutopsySnapshot?.(body) === true;

                    if (!ok) {

                        res.status(400).json({
                            ok: false,
                            error: "roomId required"
                        });

                        return;

                    }

                    res.status(204).end();

                } catch {

                    res.status(500).json({ ok: false });

                }

            }
        );

        // R14.3 — advertisement upload may carry base64 banner bytes (<= ~400KB).
        app.use((req, res, next) => {

            const path = req.path || "";

            if (
                req.method === "POST"
                && (
                    path === "/console/advertisements/upload"
                    || path === "/console/advertisements"
                )
            ) {

                return express.json({ limit: "512kb" })(req, res, next);

            }

            return next();

        });

        // R6.1 — JSON body for Developer Auth login/refresh/logout only.
        app.use(express.json({ limit: "32kb" }));

        app.get("/", (req, res) => {

            res.send("WheelWin Server Running");

        });

        app.get("/health", (req, res) => {

            const snapshot = this._healthService.getHealthSnapshot();

            this._applyProbeCacheHeaders(res);

            // R7.0B — Not Ready during DRAINING / STOPPED / startup failure path.
            if (snapshot.ready === false || snapshot.status === "not_ready") {

                res.status(503).json(snapshot);

                return;

            }

            res.json(snapshot);

        });

        // R7.0G — Kubernetes-style probes (cached, lightweight JSON).
        app.get("/ready", (req, res) => {

            const healthManager = this._deploymentManager?.getHealthManager?.()
                ?? null;

            this._applyProbeCacheHeaders(res);

            if (!healthManager) {

                res.status(503).json({
                    ready: false,
                    status: "not_ready",
                    reason: "deployment_health_unavailable"
                });

                return;

            }

            const body = healthManager.getReadinessResponse();

            res.status(body.ready ? 200 : 503).json(body);

        });

        app.get("/live", (req, res) => {

            const healthManager = this._deploymentManager?.getHealthManager?.()
                ?? null;

            this._applyProbeCacheHeaders(res);

            if (!healthManager) {

                res.status(200).json({
                    live: true,
                    status: "ok",
                    reason: "alive_fallback"
                });

                return;

            }

            const body = healthManager.getLivenessResponse();

            res.status(body.live ? 200 : 503).json(body);

        });

        app.get("/startup", (req, res) => {

            const healthManager = this._deploymentManager?.getHealthManager?.()
                ?? null;

            this._applyProbeCacheHeaders(res);

            if (!healthManager) {

                res.status(503).json({
                    startup: false,
                    status: "starting",
                    reason: "deployment_health_unavailable"
                });

                return;

            }

            const body = healthManager.getStartupResponse();

            res.status(body.startup ? 200 : 503).json(body);

        });

        // R7.0E — Prometheus/OpenMetrics (read-only) on main app path.
        const prometheusPath = this._productionConfig?.monitoring?.prometheusPath
            || "/metrics";

        app.get(prometheusPath, (req, res) => {

            const monitoring = this._monitoringManager
                || MonitoringManager.getInstance();

            if (!monitoring.isPrometheusEnabled()) {

                res.status(404).json({ error: "Prometheus metrics disabled" });

                return;

            }

            res.set("Content-Type", "text/plain; version=0.0.4; charset=utf-8");

            res.send(monitoring.getPrometheusText());

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

    _applyProbeCacheHeaders(res) {

        const cacheControl = this._deploymentManager?.getCacheControl?.()
            ?? "no-store";

        res.set("Cache-Control", cacheControl);

        res.set("Content-Type", "application/json; charset=utf-8");

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

                await this.shutdown({ reason: signal });

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

    if (error instanceof ConfigurationError) {

        logger.error(error.message);

    } else if (error instanceof LifecycleError) {

        logger.error(error.message);

        if (error.cause) {

            logger.error("Caused by", error.cause);

        }

    } else {

        logger.error("Server startup failed", error);

    }

    try {

        LoggingManager.getInstance().flushSync();

    } catch {

        // Best-effort: never mask the original startup failure.
    }

    process.exit(1);

});
