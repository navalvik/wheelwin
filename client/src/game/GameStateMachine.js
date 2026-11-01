import {
    GAME_STATES,
    getNextGameState,
    isValidGameState
} from "./GameState";

import { devLog, devWarn } from "../utils/devLog";

const LOG_PREFIX = "[GameState]";

const SERVER_PHASE_ORDER = Object.freeze({
    [GAME_STATES.PRE_GAME_READY]: 0,
    [GAME_STATES.READY]: 1,
    [GAME_STATES.SELF_TEST]: 2,
    [GAME_STATES.SPEED]: 3,
    [GAME_STATES.BRAKE]: 4,
    [GAME_STATES.RESULT]: 5
});

export class GameStateMachine {

    constructor(initialState = GAME_STATES.READY) {

        if (!isValidGameState(initialState)) {

            throw new Error(`Invalid initial game state: ${initialState}`);

        }

        this._state = initialState;

        this._serverGameId = null;

        this._serverRevision = null;

        this._listeners = new Set();

    }

    getState() {

        return this._state;

    }

    getNextState() {

        return getNextGameState(this._state);

    }

    canTransitionTo(targetState) {

        if (!isValidGameState(targetState)) {

            return false;

        }

        return getNextGameState(this._state) === targetState;

    }

    transitionTo(targetState) {

        if (!this.canTransitionTo(targetState)) {

            devWarn(
                `Invalid transition:\n\n${this._state} → ${targetState}`
            );

            return false;

        }

        const previousState = this._state;

        this._state = targetState;

        devLog(`${LOG_PREFIX}\n\n${previousState} → ${targetState}`);

        this._notify();

        return true;

    }

    advance() {

        const nextState = this.getNextState();

        if (!nextState) {

            return false;

        }

        return this.transitionTo(nextState);

    }

    applyServerState(targetState, { gameId = null, revision = null } = {}) {

        if (!isValidGameState(targetState)) {

            devWarn(
                `Invalid server game state:\n\n${targetState}`
            );

            return false;

        }

        const isNewAuthoritativeGame = Boolean(
            gameId
            && this._serverGameId
            && gameId !== this._serverGameId
            && this._state === GAME_STATES.RESULT
            && targetState === GAME_STATES.PRE_GAME_READY
        );

        if (isNewAuthoritativeGame) {

            this._serverGameId = null;

            this._serverRevision = null;

        }

        if (this._state === targetState) {

            if (gameId && this._serverGameId && gameId !== this._serverGameId) {

                return false;

            }

            if (Number.isSafeInteger(revision)
                && Number.isSafeInteger(this._serverRevision)
                && revision < this._serverRevision) {

                return false;

            }

            if (gameId) this._serverGameId = gameId;

            if (Number.isSafeInteger(revision)) this._serverRevision = revision;

            return true;

        }

        if (!isNewAuthoritativeGame
            && gameId
            && this._serverGameId
            && gameId !== this._serverGameId) {

            devWarn(`${LOG_PREFIX} dropped state for a different game`);

            return false;

        }

        if (Number.isSafeInteger(revision)
            && Number.isSafeInteger(this._serverRevision)
            && revision < this._serverRevision) {

            devWarn(`${LOG_PREFIX} dropped stale server revision ${revision}`);

            return false;

        }

        if (!Number.isSafeInteger(revision)
            && SERVER_PHASE_ORDER[targetState] < SERVER_PHASE_ORDER[this._state]) {

            devWarn(`${LOG_PREFIX} dropped regressive server phase ${targetState}`);

            return false;

        }

        const previousState = this._state;

        this._state = targetState;

        if (gameId) this._serverGameId = gameId;

        if (Number.isSafeInteger(revision)) this._serverRevision = revision;

        devLog(
            `${LOG_PREFIX} [Server]\n\n${previousState} → ${targetState}`
        );

        this._notify();

        return true;

    }

    subscribe(listener) {

        this._listeners.add(listener);

        listener(this._state);

        return () => {

            this._listeners.delete(listener);

        };

    }

    reset() {

        this._state = GAME_STATES.READY;

        this._serverGameId = null;

        this._serverRevision = null;

        this._notify();

    }

    _notify() {

        this._listeners.forEach((listener) => {

            listener(this._state);

        });

    }

}
