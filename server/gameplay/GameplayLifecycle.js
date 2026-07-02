import { EVENT_TYPES } from "../events/EventTypes.js";
import { GAME_STATES } from "../engines/gameState/GameStates.js";
import { GAME_STATUS } from "../models/GameStatus.js";

const DEFAULT_RESULT_LINGER_MS = 3000;

/**
 * C3.9 — Gameplay Core teardown coordinator.
 *
 * Releases every authoritative gameplay resource once a game reaches its
 * terminal RESULT state so that completed games do not accumulate in memory.
 * It performs no gameplay logic and owns no gameplay state; it only wires the
 * existing engine `remove*` APIs together in a deterministic order:
 *
 *   Physics simulation → Input queue → GameClock → WinnerActivation guards →
 *   Winner result → GameState → Configuration → Game record
 *
 * Room teardown is intentionally excluded — room lifecycle is owned by
 * RoomManager / RoomLobbyBridge, not the gameplay core.
 *
 * Teardown is deferred by the RESULT display duration so that clients, recovery
 * and audit can still read the authoritative result while RESULT is shown. All
 * pending timers are tracked and cleared on shutdown (no orphan timers).
 */
export class GameplayLifecycle {

    constructor({
        logger,
        eventBus,
        gameCatalog,
        physicsEngine,
        inputAuthority,
        gameClockEngine,
        gameStateEngine,
        configurationEngine,
        winnerEngine,
        winnerActivation,
        gameManager,
        devMode = false
    }) {

        this._logger = logger;

        this._eventBus = eventBus;

        this._gameCatalog = gameCatalog;

        this._physicsEngine = physicsEngine;

        this._inputAuthority = inputAuthority;

        this._gameClockEngine = gameClockEngine;

        this._gameStateEngine = gameStateEngine;

        this._configurationEngine = configurationEngine;

        this._winnerEngine = winnerEngine;

        this._winnerActivation = winnerActivation;

        this._gameManager = gameManager;

        this._devMode = devMode;

        this._handlers = [];

        this._pendingTeardowns = new Map();

        this._completed = new Set();

        this._initialized = false;

    }

    initialize() {

        this._subscribe(
            EVENT_TYPES.GAME_STATE_CHANGED,
            (envelope) => {

                this._handleGameStateChanged(envelope.payload);

            }
        );

        this._subscribe(
            EVENT_TYPES.SERVER_SHUTDOWN,
            () => {

                this._clearPendingTeardowns();

            }
        );

        this._initialized = true;

    }

    shutdown() {

        this._clearPendingTeardowns();

        for (const subscription of this._handlers) {

            this._eventBus.unsubscribe(
                subscription.event,
                subscription.handler
            );

        }

        this._handlers = [];

        this._completed.clear();

        this._initialized = false;

    }

    getPendingTeardownCount() {

        return this._pendingTeardowns.size;

    }

    _handleGameStateChanged(payload) {

        const gameId = payload?.gameId;

        const currentState = payload?.currentState ?? payload?.state;

        if (!gameId || currentState !== GAME_STATES.RESULT) {

            return;

        }

        if (this._pendingTeardowns.has(gameId) || this._completed.has(gameId)) {

            return;

        }

        const lingerMs = this._resolveResultLingerMs();

        const handle = setTimeout(() => {

            this._pendingTeardowns.delete(gameId);

            this._teardown(gameId);

        }, lingerMs);

        if (typeof handle.unref === "function") {

            handle.unref();

        }

        this._pendingTeardowns.set(gameId, handle);

    }

    _teardown(gameId) {

        this._completed.add(gameId);

        this._logStep(`Game destroyed ${gameId}`);

        if (this._physicsEngine.getSimulation(gameId)) {

            this._physicsEngine.removeSimulation(gameId);

            this._logStep("Simulation removed");

        }

        if (this._inputAuthority.hasGame(gameId)) {

            this._inputAuthority.removeGame(gameId);

            this._logStep("Queue removed");

        }

        if (this._gameClockEngine.getClock(gameId)) {

            this._gameClockEngine.removeClock(gameId);

            this._logStep("Clock removed");

        }

        if (this._winnerActivation) {

            this._winnerActivation.forgetGame(gameId);

        }

        if (this._winnerEngine.getResult(gameId)) {

            this._winnerEngine.removeResult(gameId);

            this._logStep("Winner removed");

        }

        if (this._gameStateEngine.getState(gameId)) {

            this._gameStateEngine.removeState(gameId);

            this._logStep("GameState removed");

        }

        if (this._configurationEngine.getConfiguration(gameId)) {

            this._configurationEngine.removeConfiguration(gameId);

            this._logStep("Configuration removed");

        }

        this._destroyGameRecord(gameId);

        this._logStep(`Active games: ${this._countActiveGames()}`);

    }

    _destroyGameRecord(gameId) {

        if (!this._gameManager || !this._gameManager.hasGame(gameId)) {

            return;

        }

        const snapshot = this._gameManager.getGame(gameId);

        if (snapshot?.status === GAME_STATUS.RUNNING) {

            this._gameManager.finishGame(gameId);

        }

        this._gameManager.destroyGame(gameId);

    }

    _countActiveGames() {

        if (!this._gameManager) {

            return 0;

        }

        return this._gameManager.getGames().length;

    }

    _resolveResultLingerMs() {

        const timers = this._gameCatalog?.getTimers?.();

        const durationMs = timers?.[GAME_STATES.RESULT]?.durationMs;

        if (Number.isFinite(durationMs) && durationMs > 0) {

            return durationMs;

        }

        return DEFAULT_RESULT_LINGER_MS;

    }

    _clearPendingTeardowns() {

        for (const handle of this._pendingTeardowns.values()) {

            clearTimeout(handle);

        }

        this._pendingTeardowns.clear();

    }

    _subscribe(event, handler) {

        this._eventBus.subscribe(event, handler);

        this._handlers.push({ event, handler });

    }

    _logStep(message) {

        if (!this._devMode) {

            return;

        }

        this._logger.info(`[GameplayLifecycle] ${message}`);

    }

}
