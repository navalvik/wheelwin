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
        lifecycleManager = null,
        gameplayContextResolver = null,
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
        this._lifecycleManager = lifecycleManager;
        this._gameplayContextResolver = gameplayContextResolver;
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
            gameplayContextResolver: this._gameplayContextResolver
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
            roomManager: this._roomManager,
            gameManager: this._gameManager,
            playerManager: this._playerManager,
            socketGateway: this._socketGateway,
            simulationLoop: this._simulationLoop
        });

    }

}
