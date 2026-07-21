import { GAME_STATES } from "./GameStates.js";

export const TRANSITIONS = Object.freeze({
    [GAME_STATES.PRE_GAME_READY]: Object.freeze([GAME_STATES.READY]),
    [GAME_STATES.READY]: Object.freeze([GAME_STATES.SELF_TEST]),
    [GAME_STATES.SELF_TEST]: Object.freeze([GAME_STATES.SPEED]),
    [GAME_STATES.SPEED]: Object.freeze([GAME_STATES.BRAKE]),
    [GAME_STATES.BRAKE]: Object.freeze([GAME_STATES.RESULT]),
    [GAME_STATES.RESULT]: Object.freeze([])
});

export function isValidGameState(state) {

    return Object.values(GAME_STATES).includes(state);

}

export function getAllowedTransitions(currentState) {

    return TRANSITIONS[currentState] ?? [];

}

export function isTransitionAllowed(currentState, nextState) {

    return getAllowedTransitions(currentState).includes(nextState);

}
