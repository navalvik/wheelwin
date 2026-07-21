export const GAME_STATES = Object.freeze({
    PRE_GAME_READY: "PRE_GAME_READY",
    READY: "READY",
    SELF_TEST: "SELF_TEST",
    SPEED: "SPEED",
    BRAKE: "BRAKE",
    RESULT: "RESULT"
});

export const GAME_STATE_SEQUENCE = Object.freeze([
    GAME_STATES.READY,
    GAME_STATES.SELF_TEST,
    GAME_STATES.SPEED,
    GAME_STATES.BRAKE,
    GAME_STATES.RESULT
]);

export function getNextGameState(currentState) {

    const index = GAME_STATE_SEQUENCE.indexOf(currentState);

    if (index === -1 || index >= GAME_STATE_SEQUENCE.length - 1) {

        return null;

    }

    return GAME_STATE_SEQUENCE[index + 1];

}
