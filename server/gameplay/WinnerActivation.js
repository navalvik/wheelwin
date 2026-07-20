import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { GAME_STATES } from "../engines/gameState/GameStates.js";

/**
 * C3.8 / P5.7 — Winner Activation (deferred).
 *
 * P5.7: BrakePhaseController owns BRAKE physics. WinnerEngine is not invoked
 * on PHYSICS_STOPPED. RESULT / winner determination remains for a later stage.
 * GameplayPhaseLifecycle still owns phase transitions.
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
        // WinnerActivation must not call applyBrake or resolve winners here.
        this._brakeTriggered.add(gameId);

        this._logStep("BRAKE owned by BrakePhaseController (winner deferred)");

    }

    _handlePhysicsStopped(payload) {

        const gameId = payload?.gameId;

        if (!gameId) {

            return;

        }

        // P5.7 — do not determine winner on PHYSICS_STOPPED.
        // RESULT / WinnerEngine activation is deferred to a later stage.
        this._logStep(
            `PHYSICS_STOPPED ignored for winner resolve | gameId=${gameId}`
        );

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
