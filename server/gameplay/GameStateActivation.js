import { EVENT_TYPES } from "../events/EventTypes.js";
import {
    GAME_STATES,
    getNextGameState
} from "../engines/gameState/GameStates.js";
import { isValidGameState } from "../engines/gameState/TransitionTable.js";

export class GameStateActivation {

    constructor({
        logger,
        eventBus,
        gameStateEngine,
        gameClockEngine,
        devMode = false
    }) {

        this._logger = logger;

        this._eventBus = eventBus;

        this._gameStateEngine = gameStateEngine;

        this._gameClockEngine = gameClockEngine;

        this._devMode = devMode;

        this._handlers = [];

        this._initialized = false;

    }

    initialize() {

        this._subscribe(
            EVENT_TYPES.CLOCK_STARTED,
            (envelope) => {

                this._handleClockStarted(envelope.payload);

            }
        );

        this._subscribe(
            EVENT_TYPES.PHASE_TIMEOUT,
            (envelope) => {

                this._handlePhaseTimeout(envelope.payload);

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

        this._initialized = false;

    }

    _handleClockStarted({ gameId, phase }) {

        if (!gameId || !phase) {

            return;

        }

        const currentState = this._gameStateEngine.getState(gameId);

        if (currentState !== GAME_STATES.READY) {

            return;

        }

        if (!isValidGameState(phase)) {

            return;

        }

        this._transition(gameId, phase, `Clock phase ${phase} started`);

    }

    _handlePhaseTimeout({ gameId, phase }) {

        if (!gameId || !phase) {

            return;

        }

        const nextState = getNextGameState(phase);

        if (!nextState) {

            return;

        }

        if (nextState === GAME_STATES.RESULT) {

            // C3.8: RESULT is now authoritative winner-driven. WinnerActivation
            // transitions to RESULT after the wheel stops and the winner is
            // determined, so the timer path must not advance here.
            return;

        }

        const snapshot = this._transition(
            gameId,
            nextState,
            `Phase ${phase} completed`
        );

        if (!snapshot) {

            return;

        }

        // C4.8:
        // SPEED has no scheduled duration and must NOT be completed here.
        // The SPEED phase is owned by gameplay: it stays alive until the
        // authoritative gameplay-completion signal occurs (all players have
        // reached their input limit), at which point SpeedActivation calls
        // GameClock.completePhase(gameId). The clock/state layer never ends
        // SPEED on a timer.

    }

    _transition(gameId, nextState, reason) {

        const currentState = this._gameStateEngine.getState(gameId);

        const snapshot = this._gameStateEngine.transition(gameId, nextState, {
            reason
        });

        if (!snapshot) {

            return null;

        }

        this._logTransition(currentState, nextState);

        return snapshot;

    }

    _subscribe(event, handler) {

        this._eventBus.subscribe(event, handler);

        this._handlers.push({ event, handler });

    }

    _logTransition(previousState, currentState) {

        if (!this._devMode) {

            return;

        }

        this._logger.info(
            `[GameStateActivation] ${previousState ?? "NONE"} → ${currentState}`
        );

    }

}
