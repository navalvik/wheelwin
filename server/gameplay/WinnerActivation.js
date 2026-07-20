import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { GAME_STATES } from "../engines/gameState/GameStates.js";

/**
 * P5.8 — Winner Activation.
 *
 * PHYSICS_STOPPED → WinnerEngine.resolveResult() → WINNER_DETERMINED (once).
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
        devMode = false
    }) {

        this._logger = logger;

        this._eventBus = eventBus;

        this._physicsEngine = physicsEngine;

        this._winnerEngine = winnerEngine;

        this._gameStateEngine = gameStateEngine;

        this._devMode = devMode;

        this._handlers = [];

        this._brakeTriggered = new Set();

        this._resolved = new Set();

        this._resultTransitioned = new Set();

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

        this._resolved.add(gameId);

        this._logStep("Wheel stopped");

        this._logStep("WinnerEngine.resolveResult()");

        let result;

        try {

            result = this._winnerEngine.resolveResult(gameId);

        } catch (error) {

            this._logger.error(
                `Winner determination failed | gameId=${gameId} | reason=${error.message}`
            );

            this._resolved.delete(gameId);

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

        // RESULT / Page6 remain lifecycle-owned — not started here (P5.8).
        this._resultTransitioned.add(gameId);

        this._logStep("Winner ready (RESULT / Page6 deferred)");

    }

    forgetGame(gameId) {

        this._brakeTriggered.delete(gameId);

        this._resolved.delete(gameId);

        this._resultTransitioned.delete(gameId);

    }

    _reset() {

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
