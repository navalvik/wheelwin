import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { GAME_STATES } from "../engines/gameState/GameStates.js";

/**
 * C3.8 — Winner Activation.
 *
 * Orchestration glue that connects the authoritative physics simulation to the
 * existing WinnerEngine. It never calculates winners itself and never mutates
 * physics beyond issuing the authoritative brake when the game enters BRAKE.
 *
 * Authoritative flow:
 *
 *   GAME_STATE_CHANGED(BRAKE) -> PhysicsEngine.applyBrake()
 *   PHYSICS_STOPPED           -> WinnerEngine.resolveResult() -> WINNER_DETERMINED
 *   WINNER_DETERMINED         -> GameStateEngine.transition(RESULT)
 *
 * Winner determination happens exactly once per game.
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

        this._triggerBrake(gameId);

    }

    _triggerBrake(gameId) {

        if (this._brakeTriggered.has(gameId)) {

            return;

        }

        this._brakeTriggered.add(gameId);

        this._logStep("Wheel braking requested");

        this._physicsEngine.applyBrake(gameId);

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
            winningPlayerColor: result.winningPlayer?.color ?? null,
            winningPlayerIcon: result.winningPlayer?.icon ?? null,
            finalWheelAngle: result.finalAngle,
            serverTimestamp: Date.now()
        });

        this._logStep("WINNER_DETERMINED");

    }

    _handleWinnerDetermined(payload) {

        const gameId = payload?.gameId;

        if (!gameId) {

            return;

        }

        // P5.3 — GameplayPhaseLifecycle owns the BRAKE → RESULT transition.
        // Winner resolution still runs here; RESULT entry is lifecycle-timed.
        this._resultTransitioned.add(gameId);

        this._logStep("Winner ready (RESULT transition deferred to lifecycle)");

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
