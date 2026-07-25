import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { deepFreezeRecovery } from "./recovery/recoveryFreeze.js";
import { RecoveryValidationError } from "./recovery/RecoveryValidationError.js";

export class RecoveryEngine {

    constructor({
        logger,
        eventBus,
        gameCatalog,
        configurationEngine,
        gameStateEngine,
        gameClock,
        physicsEngine,
        inputAuthority,
        winnerEngine,
        paymentEngine,
        resultActivation = null,
        preGameReadyActivation = null,
        metricsService = null
    }) {

        this._logger = logger;

        this._eventBus = eventBus;

        this._gameCatalog = gameCatalog;

        this._configurationEngine = configurationEngine;

        this._gameStateEngine = gameStateEngine;

        this._gameClock = gameClock;

        this._physicsEngine = physicsEngine;

        this._inputAuthority = inputAuthority;

        this._winnerEngine = winnerEngine;

        this._paymentEngine = paymentEngine;

        this._resultActivation = resultActivation;

        this._preGameReadyActivation = preGameReadyActivation;

        this._metricsService = metricsService;

        this._snapshots = new Map();

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

        for (const gameId of [...this._snapshots.keys()]) {

            this.removeRecoverySnapshot(gameId);

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

    recoverSession(gameId) {

        this._assertInitialized();

        this._emit(EVENT_TYPES.RECOVERY_STARTED, {
            gameId,
            timestamp: Date.now()
        });

        try {

            const snapshot = this.buildRecoverySnapshot(gameId);

            this._snapshots.set(gameId, snapshot);

            this._emit(EVENT_TYPES.SESSION_RECOVERED, {
                gameId,
                traceSeed: snapshot.metadata.traceSeed,
                timestamp: snapshot.recoveredAt
            });

            return snapshot;

        } catch (error) {

            this._handleRecoveryFailure(gameId, error);

            throw error;

        }

    }

    recoverPlayer(gameId, playerId) {

        this._assertInitialized();

        this._emit(EVENT_TYPES.RECOVERY_STARTED, {
            gameId,
            playerId,
            timestamp: Date.now()
        });

        try {

            const snapshot = this.buildRecoverySnapshot(gameId);

            const playerInput = snapshot.input.players.find(
                (entry) => entry.playerId === playerId
            );

            if (!playerInput) {

                throw new RecoveryValidationError({
                    gameId,
                    reason: `Player input state is missing (${playerId})`
                });

            }

            this._snapshots.set(gameId, snapshot);

            this._emit(EVENT_TYPES.PLAYER_RECOVERED, {
                gameId,
                playerId,
                traceSeed: snapshot.metadata.traceSeed,
                timestamp: snapshot.recoveredAt
            });

            return snapshot;

        } catch (error) {

            this._handleRecoveryFailure(gameId, error, playerId);

            throw error;

        }

    }

    buildRecoverySnapshot(gameId) {

        const build = () => {

            this._assertInitialized();

            const sources = this._collectRecoverySources(gameId);

            this._validateRecoverySources(gameId, sources);

            const snapshot = deepFreezeRecovery({
                gameId,
                configuration: sources.configuration,
                gameState: sources.gameState,
                clock: sources.clock,
                physics: sources.physics,
                input: sources.input,
                winner: sources.winner,
                payment: sources.payment,
                preGameReady: sources.preGameReady,
                openPage6: sources.openPage6 === true,
                recoveredAt: Date.now(),
                metadata: {
                    traceSeed: sources.configuration.traceSeed,
                    configurationVersion: sources.configuration.configurationVersion,
                    catalogVersion: this._gameCatalog.getCatalogVersion()
                }
            });

            this._emit(EVENT_TYPES.RECOVERY_SNAPSHOT_CREATED, {
                gameId,
                traceSeed: snapshot.metadata.traceSeed,
                timestamp: snapshot.recoveredAt
            });

            return snapshot;

        };

        if (this._metricsService?.isEnabled()) {

            return this._metricsService.time("recovery.build", build);

        }

        return build();

    }

    getRecoverySnapshot(gameId) {

        return this._snapshots.get(gameId) ?? null;

    }

    /**
     * R6.0C — Read-only enumeration for Developer Console projections.
     * Does not build or mutate snapshots.
     */
    listActiveRecoveryGameIds() {

        return [...this._snapshots.keys()];

    }

    removeRecoverySnapshot(gameId) {

        if (!this._snapshots.has(gameId)) {

            this._logger.error(
                `Recovery removal failed: snapshot not found (${gameId})`
            );

            return false;

        }

        this._snapshots.delete(gameId);

        this._emit(EVENT_TYPES.RECOVERY_REMOVED, {
            gameId,
            timestamp: Date.now()
        });

        return true;

    }

    getDebugSnapshot(gameId) {

        const sources = this._collectRecoverySources(gameId);

        let snapshot = null;

        try {

            snapshot = this.getRecoverySnapshot(gameId)
                ?? this.buildRecoverySnapshot(gameId);

        } catch {

            snapshot = null;

        }

        return {
            gameId,
            configurationLoaded: sources.configuration !== null,
            currentState: sources.gameState?.currentState ?? null,
            physicsSnapshot: sources.physics?.snapshot ?? null,
            clockState: sources.clock,
            remainingPresses: sources.input?.players?.map((player) => ({
                playerId: player.playerId,
                remainingPresses: player.remainingPresses
            })) ?? [],
            winnerStatus: sources.winner ? "resolved" : "pending",
            paymentStatus: sources.payment?.paymentStatus ?? "none",
            recoverySnapshot: snapshot
        };

    }

    _collectRecoverySources(gameId) {

        const configuration = this._configurationEngine.getConfiguration(gameId);

        const currentState = this._gameStateEngine.getState(gameId);

        const gameState = currentState === null
            ? null
            : {
                currentState,
                previousState: this._gameStateEngine.getDebugSnapshot(gameId)
                    ?.previousState ?? null,
                history: this._gameStateEngine.getHistory(gameId)
            };

        const clockRecord = this._gameClock.getClock(gameId);

        const clock = clockRecord === null
            ? null
            : {
                ...clockRecord,
                elapsed: this._gameClock.getElapsed(gameId),
                remainingTime: this._gameClock.getRemaining(gameId)
            };

        const physicsSnapshot = this._physicsEngine.getSimulation(gameId);

        const physics = physicsSnapshot === null
            ? null
            : {
                snapshot: physicsSnapshot,
                angle: physicsSnapshot.runtime.angle,
                triangleAngle: physicsSnapshot.runtime.triangleAngle,
                angularVelocity: physicsSnapshot.runtime.angularVelocity,
                triangleAngularVelocity:
                    physicsSnapshot.runtime.triangleAngularVelocity,
                angularAcceleration: physicsSnapshot.runtime.angularAcceleration,
                selfTestActive: physicsSnapshot.runtime.selfTestActive === true,
                speedActive: physicsSnapshot.runtime.speedActive === true,
                brakeActive: physicsSnapshot.runtime.brakeActive === true,
                brakeDurationMs: physicsSnapshot.runtime.brakeDurationMs ?? 0,
                brakeElapsedMs: physicsSnapshot.runtime.brakeElapsedMs ?? 0,
                brakeStartWheelOmega:
                    physicsSnapshot.runtime.brakeStartWheelOmega ?? 0,
                state: physicsSnapshot.runtime.state
            };

        const input = this._buildInputSnapshot(gameId, configuration);

        return {
            configuration,
            gameState,
            clock,
            physics,
            input,
            winner: this._winnerEngine.getResult(gameId),
            payment: this._paymentEngine.getPayment(gameId),
            preGameReady: this._preGameReadyActivation?.getSnapshot(gameId) ?? null,
            openPage6: this._resultActivation?.hasOpenedPage6(gameId) === true
        };

    }

    _buildInputSnapshot(gameId, configuration) {

        if (!this._inputAuthority.hasGame(gameId)) {

            return null;

        }

        const inputRules = this._gameCatalog.getInputRules();

        const commandHistory = this._inputAuthority.getAcceptedCommands(gameId);

        const players = (configuration?.players ?? []).map((player) => {

            const state = this._inputAuthority.getPlayerInputState(
                gameId,
                player.playerId
            );

            if (!state) {

                return null;

            }

            return {
                ...state,
                remainingPresses: Math.max(
                    0,
                    inputRules.maxPressCycles - state.pressCount
                )
            };

        });

        if (players.some((player) => player === null)) {

            return null;

        }

        return {
            commandHistory,
            players
        };

    }

    _validateRecoverySources(gameId, sources) {

        if (!sources.configuration) {

            throw new RecoveryValidationError({
                gameId,
                reason: "Configuration is missing"
            });

        }

        if (!sources.gameState) {

            throw new RecoveryValidationError({
                gameId,
                reason: "Game state is missing"
            });

        }

        if (!sources.physics) {

            throw new RecoveryValidationError({
                gameId,
                reason: "Physics snapshot is missing"
            });

        }

        if (!sources.clock) {

            throw new RecoveryValidationError({
                gameId,
                reason: "Game clock is missing"
            });

        }

        if (!sources.input) {

            throw new RecoveryValidationError({
                gameId,
                reason: "Input authority state is missing"
            });

        }

    }

    _handleRecoveryFailure(gameId, error, playerId = null) {

        const reason = error instanceof RecoveryValidationError
            ? error.reason
            : error.message;

        this._emit(EVENT_TYPES.RECOVERY_FAILED, {
            gameId,
            playerId,
            reason,
            timestamp: Date.now()
        });

    }

    _emit(type, payload) {

        this._eventBus.emit({
            source: EVENT_SOURCES.RECOVERY_ENGINE,
            type,
            payload
        });

    }

    _handleServerShutdown() {

        this._snapshots.clear();

    }

    _assertInitialized() {

        if (!this._initialized) {

            throw new Error("RecoveryEngine is not initialized");

        }

    }

}
