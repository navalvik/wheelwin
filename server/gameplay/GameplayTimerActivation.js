import { EVENT_TYPES } from "../events/EventTypes.js";
import {
    GAME_STATES,
    getNextGameState
} from "../engines/gameState/GameStates.js";

/**
 * R1.3C — Force the existing BRAKE → winner pipeline when Timer 2 expires.
 *
 * Does not call WinnerEngine. Reuses GameClock.completePhase (SPEED only) and
 * legal GameState transitions into BRAKE so WinnerActivation can run.
 */
export class GameplayTimerActivation {

    constructor({
        logger,
        eventBus,
        gameClockEngine,
        gameStateEngine,
        devMode = false
    }) {

        this._logger = logger;

        this._eventBus = eventBus;

        this._gameClockEngine = gameClockEngine;

        this._gameStateEngine = gameStateEngine;

        this._devMode = devMode;

        this._handlers = [];

        this._forced = new Set();

        this._initialized = false;

    }

    initialize() {

        this._subscribe(
            EVENT_TYPES.GAMEPLAY_TIMER_EXPIRED,
            (envelope) => {

                this._handleExpired(envelope.payload);

            }
        );

        this._subscribe(
            EVENT_TYPES.GAME_DESTROYED,
            (envelope) => {

                const gameId = envelope.payload?.gameId;

                if (gameId) {

                    this._forced.delete(gameId);

                }

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

        this._forced.clear();

        this._initialized = false;

    }

    forgetGame(gameId) {

        this._forced.delete(gameId);

    }

    _handleExpired(payload) {

        const gameId = payload?.gameId;

        if (!gameId) {

            return;

        }

        if (this._forced.has(gameId)) {

            return;

        }

        const state = this._gameStateEngine.getState(gameId);

        if (!state || state === GAME_STATES.RESULT) {

            return;

        }

        this._forced.add(gameId);

        this._logStep(`Gameplay timer expired — forcing BRAKE | gameId=${gameId}`);

        this._forceBrake(gameId);

    }

    _forceBrake(gameId) {

        let guard = 0;

        while (guard < 8) {

            guard += 1;

            const state = this._gameStateEngine.getState(gameId);

            if (!state || state === GAME_STATES.RESULT) {

                return;

            }

            if (state === GAME_STATES.BRAKE) {

                return;

            }

            const nextState = getNextGameState(state);

            if (!nextState || nextState === GAME_STATES.RESULT) {

                return;

            }

            // SPEED is open-ended — completePhase advances the phase clock only
            // when the clock is actually on SPEED (null duration).
            if (state === GAME_STATES.SPEED) {

                const clock = this._gameClockEngine.getClock(gameId);

                if (clock?.currentPhase === GAME_STATES.SPEED) {

                    this._gameClockEngine.completePhase(gameId);

                }

            }

            const snapshot = this._gameStateEngine.transition(
                gameId,
                nextState,
                { reason: "Gameplay timer expired" }
            );

            if (!snapshot) {

                this._logger.error(
                    `Gameplay timer force-BRAKE transition failed | `
                        + `gameId=${gameId} | from=${state} | to=${nextState}`
                );

                return;

            }

        }

        this._logger.error(
            `Gameplay timer force-BRAKE aborted (guard) | gameId=${gameId}`
        );

    }

    _subscribe(event, handler) {

        this._eventBus.subscribe(event, handler);

        this._handlers.push({ event, handler });

    }

    _logStep(message) {

        if (!this._devMode) {

            return;

        }

        this._logger.info(`[GameplayTimerActivation] ${message}`);

    }

}
