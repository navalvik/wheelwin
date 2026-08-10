import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { GAME_STATES } from "../engines/gameState/GameStates.js";

/** R9.2 — bounded resolve attempts after PHYSICS_STOPPED (1 immediate + retries). */
const DEFAULT_RESOLVE_ATTEMPTS = 3;

/** R9.2 — non-blocking delay between resolve attempts (ms). */
const DEFAULT_RESOLVE_RETRY_DELAY_MS = 25;

/**
 * P5.8 — Winner Activation.
 *
 * PHYSICS_STOPPED → WinnerEngine.resolveResult() → WINNER_DETERMINED (once).
 * R9.2 — bounded non-blocking retry on resolve failure (no physics replay).
 * BrakePhaseController owns BRAKE physics (P5.7).
 * GameplayPhaseLifecycle owns RESULT / Page6 transitions (deferred).
 */
export class WinnerActivation {

    constructor({
        logger,
        eventBus,
        physicsEngine,
        winnerEngine,
        gameStateEngine,
        devMode = false,
        resolveAttempts = DEFAULT_RESOLVE_ATTEMPTS,
        resolveRetryDelayMs = DEFAULT_RESOLVE_RETRY_DELAY_MS
    }) {

        this._logger = logger;

        this._eventBus = eventBus;

        this._physicsEngine = physicsEngine;

        this._winnerEngine = winnerEngine;

        this._gameStateEngine = gameStateEngine;

        this._devMode = devMode;

        this._resolveAttempts = Number.isFinite(resolveAttempts) && resolveAttempts > 0
            ? Math.floor(resolveAttempts)
            : DEFAULT_RESOLVE_ATTEMPTS;

        this._resolveRetryDelayMs = Number.isFinite(resolveRetryDelayMs)
            && resolveRetryDelayMs >= 0
            ? resolveRetryDelayMs
            : DEFAULT_RESOLVE_RETRY_DELAY_MS;

        this._handlers = [];

        this._brakeTriggered = new Set();

        this._resolved = new Set();

        this._resultTransitioned = new Set();

        /** @type {Map<string, ReturnType<typeof setTimeout>>} */
        this._retryTimers = new Map();

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
            EVENT_TYPES.PHYSICS_STOPPED,
            (envelope) => {

                this._handlePhysicsStopped(envelope.payload);

            }
        );

        this._subscribe(
            EVENT_TYPES.WINNER_DETERMINED,
            (envelope) => {

                this._handleWinnerDetermined(envelope.payload);

            }
        );

        this._subscribe(
            EVENT_TYPES.SERVER_SHUTDOWN,
            () => {

                this._reset();

            }
        );

        this._initialized = true;

    }

    shutdown() {

        for (const subscription of this._handlers) {

            this._eventBus.unsubscribe(
                subscription.event,
                subscription.handler
            );

        }

        this._handlers = [];

        this._reset();

        this._initialized = false;

    }

    _handleGameStateChanged(payload) {

        const gameId = payload?.gameId;

        const currentState = payload?.currentState ?? payload?.state;

        if (!gameId || currentState !== GAME_STATES.BRAKE) {

            return;

        }

        // P5.7 — BrakePhaseController owns Page5 BRAKE physics.
        this._brakeTriggered.add(gameId);

        this._logStep("BRAKE owned by BrakePhaseController");

    }

    _handlePhysicsStopped(payload) {

        const gameId = payload?.gameId;

        if (!gameId || this._resolved.has(gameId)) {

            return;

        }

        // Claim once — prevents duplicate WINNER_DETERMINED / retry chains.
        this._resolved.add(gameId);

        this._logStep("Wheel stopped");

        this._attemptResolve(gameId, 1);

    }

    /**
     * R9.2 — Try WinnerEngine.resolveResult with bounded non-blocking retries.
     * Does not replay PHYSICS_STOPPED or physics.
     */
    _attemptResolve(gameId, attempt) {

        this._clearRetryTimer(gameId);

        this._logStep(
            `WinnerEngine.resolveResult() attempt ${attempt}/${this._resolveAttempts}`
        );

        let result;

        try {

            result = this._winnerEngine.resolveResult(gameId);

        } catch (error) {

            const reason = error?.message ?? String(error);

            if (attempt < this._resolveAttempts) {

                this._logger.warn(
                    `Winner determination retry scheduled | gameId=${gameId} | `
                        + `attempt=${attempt}/${this._resolveAttempts} | reason=${reason}`
                );

                const timerId = setTimeout(() => {

                    this._retryTimers.delete(gameId);

                    this._attemptResolve(gameId, attempt + 1);

                }, this._resolveRetryDelayMs);

                this._retryTimers.set(gameId, timerId);

                return;

            }

            this._logger.error(
                `Winner determination failed permanently | gameId=${gameId} | `
                    + `attempts=${this._resolveAttempts} | reason=${reason}`
            );

            // Keep _resolved so we do not start another chain without PHYSICS_STOPPED.
            return;

        }

        this._logStep(`Winning Sector ${result.winningSector?.sectorId ?? "?"}`);

        this._logStep(`Winning Player ${result.winningPlayer?.playerId ?? "?"}`);

        this._emit(EVENT_TYPES.WINNER_DETERMINED, {
            gameId,
            winningSector: {
                index: result.winningSector?.index ?? null,
                sectorId: result.winningSector?.sectorId ?? null,
                color: result.winningSector?.color ?? null,
                icon: result.winningSector?.icon ?? null
            },
            winningPlayerId: result.winningPlayer?.playerId ?? null,
            winnerPlayerId: result.winnerPlayerId
                ?? result.winningPlayer?.playerId
                ?? null,
            winningPlayerColor: result.winningPlayer?.color ?? null,
            winningPlayerIcon: result.winningPlayer?.icon ?? null,
            winnerSectorIndex: result.winnerSectorIndex
                ?? result.winningSector?.index
                ?? null,
            finalWheelAngle: result.finalAngle ?? result.wheelFinalAngle ?? null,
            wheelFinalAngle: result.wheelFinalAngle ?? result.finalAngle ?? null,
            triangleFinalAngle: result.triangleFinalAngle ?? null,
            resolvedAt: result.resolvedAt ?? null,
            serverTimestamp: result.resolvedAt ?? Date.now()
        });

        this._logStep("WINNER_DETERMINED");

    }

    _handleWinnerDetermined(payload) {

        const gameId = payload?.gameId;

        if (!gameId) {

            return;

        }

        // RESULT / Page6 owned by ResultActivation + GameplayPhaseLifecycle (P5.9).
        this._resultTransitioned.add(gameId);

        this._logStep("Winner ready (ResultActivation owns RESULT)");

    }

    forgetGame(gameId) {

        this._clearRetryTimer(gameId);

        this._brakeTriggered.delete(gameId);

        this._resolved.delete(gameId);

        this._resultTransitioned.delete(gameId);

    }

    _clearRetryTimer(gameId) {

        const timerId = this._retryTimers.get(gameId);

        if (timerId != null) {

            clearTimeout(timerId);

            this._retryTimers.delete(gameId);

        }

    }

    _reset() {

        for (const gameId of [...this._retryTimers.keys()]) {

            this._clearRetryTimer(gameId);

        }

        this._brakeTriggered.clear();

        this._resolved.clear();

        this._resultTransitioned.clear();

    }

    _subscribe(event, handler) {

        this._eventBus.subscribe(event, handler);

        this._handlers.push({ event, handler });

    }

    _emit(type, payload) {

        this._eventBus.emit({
            source: EVENT_SOURCES.WINNER_ENGINE,
            type,
            payload
        });

    }

    _logStep(message) {

        if (!this._devMode) {

            return;

        }

        this._logger.info(`[WinnerActivation] ${message}`);

    }

}
