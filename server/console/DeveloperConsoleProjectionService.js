import { createRequire } from "node:module";

import { buildServerOverview } from "./projectionBuilders/buildServerOverview.js";
import { buildRoomsIndex } from "./projectionBuilders/buildRoomsIndex.js";
import { buildRoomDetail } from "./projectionBuilders/buildRoomDetail.js";
import { buildGameDetail } from "./projectionBuilders/buildGameDetail.js";
import { buildPlayersIndex } from "./projectionBuilders/buildPlayersIndex.js";
import { buildPaymentsOverview } from "./projectionBuilders/buildPaymentsOverview.js";
import { buildRecoveryOverview } from "./projectionBuilders/buildRecoveryOverview.js";
import { buildSimulationOverview } from "./projectionBuilders/buildSimulationOverview.js";
import { buildMetricsOverview } from "./projectionBuilders/buildMetricsOverview.js";
import { buildSystemInformation } from "./projectionBuilders/buildSystemInformation.js";
import { buildBlockchainStatus } from "./projectionBuilders/buildBlockchainStatus.js";
import { buildDeployerWalletStatus as buildDeployerWalletStatusDto } from "./projectionBuilders/buildDeployerWalletStatus.js";
import { buildRuntimeConfigurationSnapshot } from "./configuration/buildRuntimeConfigurationSnapshot.js";
import { buildAudioRegistrySnapshot } from "./configuration/buildAudioRegistrySnapshot.js";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json");

/**
 * R6.0C — Single read-only adapter between authoritative managers and the
 * Developer Console HTTP API.
 *
 * - never owns state
 * - never caches gameplay state
 * - never mutates managers
 * - never starts timers
 * - never emits gameplay events
 *
 * Each call assembles a fresh immutable DTO from manager getters.
 */
export class DeveloperConsoleProjectionService {

    constructor({
        roomManager,
        gameManager,
        playerManager,
        setupSessionLifecycle = null,
        paymentSessionManager = null,
        gameContractManager = null,
        contractSettlementManager = null,
        gameStartAuthorization = null,
        resultSessionLifecycle = null,
        recoveryEngine = null,
        recoverySnapshotCache = null,
        simulationLoop = null,
        physicsEngine = null,
        gameStateEngine = null,
        gameClockEngine = null,
        winnerEngine = null,
        socketGateway = null,
        metricsService = null,
        healthService = null,
        monitoringManager = null,
        lifecycleManager = null,
        gameplayContextResolver = null,
        runtimeConfig = null,
        tonService = null,
        blockchainMonitor = null,
        walletManager = null,
        tonFinancialRecovery = null,
        roomLobbyBridge = null,
        runtimeConfigurationService = null,
        audioRegistryService = null,
        walletBalanceMonitor = null,
        version = packageJson.version,
        startedAt = Date.now()
    }) {

        this._roomManager = roomManager;
        this._gameManager = gameManager;
        this._playerManager = playerManager;
        this._setupSessionLifecycle = setupSessionLifecycle;
        this._paymentSessionManager = paymentSessionManager;
        this._gameContractManager = gameContractManager;
        this._contractSettlementManager = contractSettlementManager;
        this._gameStartAuthorization = gameStartAuthorization;
        this._resultSessionLifecycle = resultSessionLifecycle;
        this._recoveryEngine = recoveryEngine;
        this._recoverySnapshotCache = recoverySnapshotCache;
        this._simulationLoop = simulationLoop;
        this._physicsEngine = physicsEngine;
        this._gameStateEngine = gameStateEngine;
        this._gameClockEngine = gameClockEngine;
        this._winnerEngine = winnerEngine;
        this._socketGateway = socketGateway;
        this._metricsService = metricsService;
        this._healthService = healthService;
        // R17.9T.8-completion — read-only access to monitoring registry gauges.
        this._monitoringManager = monitoringManager;
        this._lifecycleManager = lifecycleManager;
        this._gameplayContextResolver = gameplayContextResolver;
        this._runtimeConfig = runtimeConfig;
        this._tonService = tonService;
        this._blockchainMonitor = blockchainMonitor;
        this._walletManager = walletManager;
        this._tonFinancialRecovery = tonFinancialRecovery;
        this._roomLobbyBridge = roomLobbyBridge;
        this._runtimeConfigurationService = runtimeConfigurationService;
        this._audioRegistryService = audioRegistryService;
        this._walletBalanceMonitor = walletBalanceMonitor;
        this._version = version;
        this._startedAt = startedAt;

    }

    buildServerOverview() {

        return buildServerOverview({
            version: this._version,
            startedAt: this._startedAt,
            healthService: this._healthService,
            lifecycleManager: this._lifecycleManager,
            roomManager: this._roomManager,
            gameManager: this._gameManager,
            playerManager: this._playerManager,
            setupSessionLifecycle: this._setupSessionLifecycle,
            recoveryEngine: this._recoveryEngine,
            simulationLoop: this._simulationLoop,
            socketGateway: this._socketGateway,
            resultSessionLifecycle: this._resultSessionLifecycle
        });

    }

    buildRoomsIndex() {

        return buildRoomsIndex({
            roomManager: this._roomManager,
            gameManager: this._gameManager,
            setupSessionLifecycle: this._setupSessionLifecycle,
            gameplayContextResolver: this._gameplayContextResolver
        });

    }

    buildRoomDetail(roomId) {

        if (!roomId) {

            return null;

        }

        return buildRoomDetail(roomId, {
            roomManager: this._roomManager,
            playerManager: this._playerManager,
            gameManager: this._gameManager,
            setupSessionLifecycle: this._setupSessionLifecycle,
            paymentSessionManager: this._paymentSessionManager,
            gameContractManager: this._gameContractManager,
            gameStartAuthorization: this._gameStartAuthorization,
            gameStateEngine: this._gameStateEngine,
            gameClockEngine: this._gameClockEngine,
            resultSessionLifecycle: this._resultSessionLifecycle,
            gameplayContextResolver: this._gameplayContextResolver,
            roomLobbyBridge: this._roomLobbyBridge
        });

    }

    buildGameDetail(gameId) {

        if (!gameId) {

            return null;

        }

        return buildGameDetail(gameId, {
            gameManager: this._gameManager,
            roomManager: this._roomManager,
            gameStateEngine: this._gameStateEngine,
            winnerEngine: this._winnerEngine,
            physicsEngine: this._physicsEngine,
            simulationLoop: this._simulationLoop,
            paymentSessionManager: this._paymentSessionManager,
            gameContractManager: this._gameContractManager,
            contractSettlementManager: this._contractSettlementManager,
            gameStartAuthorization: this._gameStartAuthorization,
            resultSessionLifecycle: this._resultSessionLifecycle,
            gameplayContextResolver: this._gameplayContextResolver
        });

    }

    buildPlayersIndex() {

        return buildPlayersIndex({
            playerManager: this._playerManager,
            roomManager: this._roomManager,
            gameManager: this._gameManager,
            setupSessionLifecycle: this._setupSessionLifecycle,
            paymentSessionManager: this._paymentSessionManager,
            gameStartAuthorization: this._gameStartAuthorization,
            gameStateEngine: this._gameStateEngine,
            resultSessionLifecycle: this._resultSessionLifecycle
        });

    }

    buildPaymentsOverview() {

        return buildPaymentsOverview({
            paymentSessionManager: this._paymentSessionManager,
            gameContractManager: this._gameContractManager,
            contractSettlementManager: this._contractSettlementManager
        });

    }

    buildRecoveryOverview() {

        return buildRecoveryOverview({
            recoveryEngine: this._recoveryEngine,
            recoverySnapshotCache: this._recoverySnapshotCache,
            playerManager: this._playerManager
        });

    }

    buildSimulationOverview() {

        return buildSimulationOverview({
            simulationLoop: this._simulationLoop,
            physicsEngine: this._physicsEngine,
            metricsService: this._metricsService
        });

    }

    buildMetricsOverview() {

        return buildMetricsOverview({
            metricsService: this._metricsService,
            healthService: this._healthService,
            monitoringManager: this._monitoringManager,
            roomManager: this._roomManager,
            gameManager: this._gameManager,
            playerManager: this._playerManager,
            socketGateway: this._socketGateway,
            simulationLoop: this._simulationLoop
        });

    }

    buildSystemInformation() {

        return buildSystemInformation({
            version: this._version,
            startedAt: this._startedAt,
            runtimeConfig: this._runtimeConfig,
            healthService: this._healthService
        });

    }

    buildBlockchainStatus() {

        return buildBlockchainStatus({
            runtimeConfig: this._runtimeConfig,
            tonService: this._tonService,
            blockchainMonitor: this._blockchainMonitor,
            walletManager: this._walletManager,
            gameContractManager: this._gameContractManager,
            paymentSessionManager: this._paymentSessionManager,
            contractSettlementManager: this._contractSettlementManager,
            tonFinancialRecovery: this._tonFinancialRecovery
        });

    }

    buildDeployerWalletStatus() {

        return buildDeployerWalletStatusDto({
            runtimeConfig: this._runtimeConfig,
            tonService: this._tonService
        });

    }

    /**
     * R17.9G.1 — Runtime configuration projection (admin sees values; viewer redacted).
     * @param {{ canEdit?: boolean }} [options]
     */
    buildRuntimeConfiguration({ canEdit = false } = {}) {

        const service = this._runtimeConfigurationService;
        const state = service?.getState?.() ?? null;
        const settlementDefault = this._contractSettlementManager
            ?.getSettlementTimeoutMs?.()
            ?? undefined;

        return buildRuntimeConfigurationSnapshot({
            runtimeConfig: this._runtimeConfig,
            env: process.env,
            overrides: service?.getOverrides?.() ?? null,
            configVersion: state?.configVersion ?? null,
            canEdit: canEdit === true,
            settlementTimeoutMsDefault: settlementDefault
        });

    }

    /**
     * R17.9H — Cached wallet balance monitor snapshot (read-only).
     */
    buildWalletBalances() {

        if (!this._walletBalanceMonitor?.getSnapshot) {

            return Object.freeze({
                schemaVersion: 1,
                refreshIntervalMs: 30000,
                network: this._runtimeConfig?.ton?.network ?? null,
                generatedAt: Date.now(),
                wallets: Object.freeze([]),
                error: "Wallet balance monitor unavailable"
            });

        }

        return this._walletBalanceMonitor.getSnapshot();

    }

    /**
     * R17.9I.2 / R17.9I.3 — Audio Registry projection (Administrator-only route).
     */
    buildAudioRegistry({ canEdit = true } = {}) {

        if (this._audioRegistryService?.buildSnapshot) {

            return this._audioRegistryService.buildSnapshot({
                canEdit: canEdit === true
            });

        }

        return buildAudioRegistrySnapshot({
            env: process.env,
            canEdit: canEdit === true
        });

    }

}
