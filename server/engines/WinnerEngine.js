import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { PHYSICS_SIMULATION_STATE } from "./physics/PhysicsSimulationState.js";
import { GeometryAdapter } from "./winner/GeometryAdapter.js";
import { PlayerResolver } from "./winner/PlayerResolver.js";
import { deepFreezeResult } from "./winner/resultFreeze.js";
import { SectorResolver } from "./winner/SectorResolver.js";
import { WinnerResolutionError } from "./winner/WinnerResolutionError.js";

export class WinnerEngine {

    constructor({
        logger,
        eventBus,
        physicsEngine,
        configurationEngine,
        gameCatalog
    }) {

        this._logger = logger;

        this._eventBus = eventBus;

        this._physicsEngine = physicsEngine;

        this._configurationEngine = configurationEngine;

        this._gameCatalog = gameCatalog;

        this._geometryAdapter = new GeometryAdapter({
            angleToleranceRadians: gameCatalog.getWinnerRules()
                .angleToleranceRadians
        });

        this._sectorResolver = new SectorResolver({
            geometryAdapter: this._geometryAdapter
        });

        this._playerResolver = new PlayerResolver();

        this._results = new Map();

        this._infrastructureHandlers = [];

        this._initialized = false;

    }

    initialize() {

        const shutdownHandler = () => {

            this._handleServerShutdown();

        };

        this._eventBus.subscribe(
            EVENT_TYPES.SERVER_SHUTDOWN,
            shutdownHandler
        );

        this._infrastructureHandlers.push({
            event: EVENT_TYPES.SERVER_SHUTDOWN,
            handler: shutdownHandler
        });

        this._initialized = true;

    }

    shutdown() {

        for (const gameId of [...this._results.keys()]) {

            this.removeResult(gameId);

        }

        for (const subscription of this._infrastructureHandlers) {

            this._eventBus.unsubscribe(
                subscription.event,
                subscription.handler
            );

        }

        this._infrastructureHandlers = [];

        this._initialized = false;

    }

    resolveWinningSector(gameId) {

        this._assertInitialized();

        const { configuration, physics } = this._readResolutionInputs(gameId);

        const triangleFinalAngle = Number.isFinite(physics.runtime.triangleAngle)
            ? physics.runtime.triangleAngle
            : 0;

        const winningSector = this._sectorResolver.resolve({
            configuration,
            finalWheelAngleRadians: physics.runtime.angle,
            triangleAngleDegrees: triangleFinalAngle * (180 / Math.PI)
        });

        this._logger.info("Winning Sector Resolved");

        this._emit(EVENT_TYPES.WINNING_SECTOR_RESOLVED, {
            gameId,
            winningSector,
            finalAngle: physics.runtime.angle,
            timestamp: Date.now()
        });

        return winningSector;

    }

    resolveWinningPlayer(gameId, winningSector) {

        this._assertInitialized();

        const configuration = this._configurationEngine.getConfiguration(gameId);

        if (!configuration) {

            throw new WinnerResolutionError({
                gameId,
                reason: "Configuration is missing"
            });

        }

        if (!winningSector) {

            throw new WinnerResolutionError({
                gameId,
                reason: "Winning sector is required"
            });

        }

        const winningPlayer = this._playerResolver.resolve({
            configuration,
            winningSector
        });

        this._logger.info("Winning Player Resolved");

        return winningPlayer;

    }

    resolveResult(gameId) {

        this._assertInitialized();

        // P5.8 — Idempotent: repeated calls return the frozen stored result.
        if (this._results.has(gameId)) {

            return this._results.get(gameId);

        }

        try {

            const { configuration, physics } = this._readResolutionInputs(gameId);

            const wheelFinalAngle = physics.runtime.angle;

            const triangleFinalAngle = Number.isFinite(physics.runtime.triangleAngle)
                ? physics.runtime.triangleAngle
                : 0;

            const triangleAngleDegrees = triangleFinalAngle * (180 / Math.PI);

            const winningSector = this._sectorResolver.resolve({
                configuration,
                finalWheelAngleRadians: wheelFinalAngle,
                triangleAngleDegrees
            });

            this._logger.info("Winning Sector Resolved");

            this._emit(EVENT_TYPES.WINNING_SECTOR_RESOLVED, {
                gameId,
                winningSector,
                finalAngle: wheelFinalAngle,
                timestamp: Date.now()
            });

            const winningPlayer = this._playerResolver.resolve({
                configuration,
                winningSector
            });

            this._logger.info("Winning Player Resolved");

            const resolvedAt = Date.now();

            const result = {
                gameId,
                winningSector,
                winningPlayer,
                winnerPlayerId: winningPlayer.playerId,
                winnerSectorIndex: winningSector.index,
                prize: null,
                payout: null,
                finalAngle: wheelFinalAngle,
                wheelFinalAngle,
                triangleFinalAngle,
                resolvedAt,
                traceSeed: configuration.traceSeed,
                metadata: {
                    configurationVersion: configuration.configurationVersion
                }
            };

            this._validateResult(result, configuration);

            const frozenResult = deepFreezeResult(result);

            this._results.set(gameId, frozenResult);

            this._logger.info("Game Result Ready");

            this._emit(EVENT_TYPES.GAME_RESULT_READY, {
                gameId,
                winningSector,
                winningPlayer,
                finalAngle: frozenResult.finalAngle,
                wheelFinalAngle: frozenResult.wheelFinalAngle,
                triangleFinalAngle: frozenResult.triangleFinalAngle,
                timestamp: frozenResult.resolvedAt
            });

            return frozenResult;

        } catch (error) {

            if (error instanceof WinnerResolutionError) {

                this._logger.error(
                    `Result resolution failed | gameId=${gameId} | reason=${error.reason}`
                );

                throw error;

            }

            throw new WinnerResolutionError({
                gameId,
                reason: error.message
            });

        }

    }

    /**
     * R17.9T.6-D2 — Silent full-result attachment for recovery.
     *
     * Attaches a complete authoritative winner result WITHOUT emitting
     * WINNING_SECTOR_RESOLVED or GAME_RESULT_READY.
     *
     * @param {object} result
     * @returns {object|null} The attached frozen result, or null on failure.
     */
    attachResult(result) {

        this._assertInitialized();

        if (!result || typeof result !== "object") {

            this._logger.error("Result attach failed: result is required");

            return null;

        }

        const gameId = result.gameId;

        if (!gameId) {

            this._logger.error("Result attach failed: gameId is required");

            return null;

        }

        const configuration = this._configurationEngine.getConfiguration(gameId);

        if (!configuration) {

            this._logger.error(
                `Result attach failed: configuration is missing (${gameId})`
            );

            return null;

        }

        // Validate the result structure.
        try {

            this._validateResult(result, configuration);

        } catch (error) {

            this._logger.error(
                `Result attach failed: ${error?.message ?? "validation error"} (${gameId})`
            );

            return null;

        }

        // Duplicate handling.
        if (this._results.has(gameId)) {

            const existing = this._results.get(gameId);

            if (existing.winnerPlayerId === result.winnerPlayerId
                && existing.winnerSectorIndex === result.winnerSectorIndex) {

                this._logger.info(
                    `Result attach: equivalent result already attached (${gameId})`
                );

                return existing;

            }

            this._logger.error(
                `Result attach failed: conflicting result already exists (${gameId})`
            );

            return null;

        }

        const frozenResult = deepFreezeResult(result);

        this._results.set(gameId, frozenResult);

        this._logger.info("Result Attached");

        return frozenResult;

    }

    /**
     * R17.9T.6-D2 — Silent deterministic winner recomputation for terminal RESULT.
     *
     * Recomputes the winner outcome from the exact attached configuration and
     * terminal STOPPED physics WITHOUT emitting WINNING_SECTOR_RESOLVED or
     * GAME_RESULT_READY.
     *
     * NOTE: The historical resolvedAt timestamp is NOT persisted in the current
     * recovery contract. This method does NOT invent it. The returned result
     * exposes `resolvedAt: null` to make this limitation explicit.
     *
     * @param {string} gameId
     * @returns {object|null} The recomputed frozen result, or null on failure.
     */
    restoreResult(gameId) {

        this._assertInitialized();

        if (!gameId) {

            this._logger.error("Result restore failed: gameId is required");

            return null;

        }

        // Duplicate handling.
        if (this._results.has(gameId)) {

            const existing = this._results.get(gameId);

            this._logger.info(
                `Result restore: result already attached (${gameId})`
            );

            return existing;

        }

        try {

            const { configuration, physics } = this._readResolutionInputs(gameId);

            const wheelFinalAngle = physics.runtime.angle;

            const triangleFinalAngle = Number.isFinite(physics.runtime.triangleAngle)
                ? physics.runtime.triangleAngle
                : 0;

            const triangleAngleDegrees = triangleFinalAngle * (180 / Math.PI);

            const winningSector = this._sectorResolver.resolve({
                configuration,
                finalWheelAngleRadians: wheelFinalAngle,
                triangleAngleDegrees
            });

            const winningPlayer = this._playerResolver.resolve({
                configuration,
                winningSector
            });

            const result = {
                gameId,
                winningSector,
                winningPlayer,
                winnerPlayerId: winningPlayer.playerId,
                winnerSectorIndex: winningSector.index,
                prize: null,
                payout: null,
                finalAngle: wheelFinalAngle,
                wheelFinalAngle,
                triangleFinalAngle,
                // Historical resolvedAt is not persisted in the current contract.
                resolvedAt: null,
                traceSeed: configuration.traceSeed,
                metadata: {
                    configurationVersion: configuration.configurationVersion
                }
            };

            this._validateResult(result, configuration);

            const frozenResult = deepFreezeResult(result);

            this._results.set(gameId, frozenResult);

            this._logger.info("Result Restored");

            return frozenResult;

        } catch (error) {

            this._logger.error(
                `Result restore failed | gameId=${gameId} | reason=${error?.message ?? "unknown"}`
            );

            return null;

        }

    }

    getResult(gameId) {

        return this._results.get(gameId) ?? null;

    }

    removeResult(gameId) {

        if (!this._results.has(gameId)) {

            this._logger.error(
                `Result removal failed: result not found (${gameId})`
            );

            return false;

        }

        this._results.delete(gameId);

        this._logger.info("Result Removed");

        this._emit(EVENT_TYPES.GAME_RESULT_REMOVED, {
            gameId,
            timestamp: Date.now()
        });

        return true;

    }

    getDebugSnapshot(gameId) {

        const result = this._results.get(gameId);

        if (!result) {

            return null;

        }

        return {
            gameId,
            winningSector: result.winningSector,
            winningPlayer: result.winningPlayer,
            finalAngle: result.finalAngle,
            traceSeed: result.traceSeed,
            resolvedAt: result.resolvedAt
        };

    }

    _readResolutionInputs(gameId) {

        const configuration = this._configurationEngine.getConfiguration(gameId);

        if (!configuration) {

            throw new WinnerResolutionError({
                gameId,
                reason: "Configuration is missing"
            });

        }

        const physics = this._physicsEngine.getSimulation(gameId);

        if (!physics) {

            throw new WinnerResolutionError({
                gameId,
                reason: "Physics simulation is missing"
            });

        }

        if (physics.runtime.state !== PHYSICS_SIMULATION_STATE.STOPPED) {

            throw new WinnerResolutionError({
                gameId,
                reason: "Physics simulation is not complete"
            });

        }

        if (!Number.isFinite(physics.runtime.angle)) {

            throw new WinnerResolutionError({
                gameId,
                reason: "Final angle is invalid"
            });

        }

        return { configuration, physics };

    }

    _validateResult(result, configuration) {

        if (!result.winningSector?.sectorId) {

            throw new WinnerResolutionError({
                gameId: result.gameId,
                reason: "Winning sector is invalid"
            });

        }

        if (!result.winningPlayer?.playerId) {

            throw new WinnerResolutionError({
                gameId: result.gameId,
                reason: "Winning player is invalid"
            });

        }

        const ownerExists = configuration.players.some(
            (player) => player.playerId === result.winningPlayer.playerId
        );

        if (!ownerExists) {

            throw new WinnerResolutionError({
                gameId: result.gameId,
                reason: "Winning player does not exist in configuration"
            });

        }

    }

    _emit(type, payload) {

        this._eventBus.emit({
            source: EVENT_SOURCES.WINNER_ENGINE,
            type,
            payload
        });

    }

    _handleServerShutdown() {

        this._results.clear();

    }

    _assertInitialized() {

        if (!this._initialized) {

            throw new Error("WinnerEngine is not initialized");

        }

    }

}
