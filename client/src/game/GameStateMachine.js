import {
    GAME_STATES,
    getNextGameState,
    isValidGameState
} from "./GameState";

import { devLog, devWarn } from "../utils/devLog";

const LOG_PREFIX = "[GameState]";

export class GameStateMachine {

    constructor(initialState = GAME_STATES.READY) {

        if (!isValidGameState(initialState)) {

            throw new Error(`Invalid initial game state: ${initialState}`);

        }

        this._state = initialState;

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

    applyServerState(targetState) {

        if (!isValidGameState(targetState)) {

            devWarn(
                `Invalid server game state:\n\n${targetState}`
            );

            return false;

        }

        if (this._state === targetState) {

            return true;

        }

        const previousState = this._state;

        this._state = targetState;

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

        this._notify();

    }

    _notify() {

        this._listeners.forEach((listener) => {

            listener(this._state);

        });

    }

}
