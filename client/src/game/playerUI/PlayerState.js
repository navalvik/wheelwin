import { GAME_STATES } from "../GameState";

import { RESULT_OUTCOMES } from "../centralButton/ButtonState";

export const PLAYER_UI_STATES = Object.freeze({
    READY: "READY",
    WAIT: "WAIT",
    PRESS: "PRESS",
    SPEED: "SPEED",
    BRAKE: "BRAKE",
    WIN: "WIN",
    LOST: "LOST",
    OFFLINE: "OFFLINE"
});

export const PLAYER_COUNT = 3;

export function mapGameStateToPlayerUIState(gameState, resultOutcome) {

    switch (gameState) {

        case GAME_STATES.READY:

            return PLAYER_UI_STATES.READY;

        case GAME_STATES.COUNTDOWN:

            return PLAYER_UI_STATES.WAIT;

        case GAME_STATES.SELF_TEST:

            return PLAYER_UI_STATES.PRESS;

        case GAME_STATES.SPEED:

            return PLAYER_UI_STATES.SPEED;

        case GAME_STATES.BRAKE:

            return PLAYER_UI_STATES.BRAKE;

        case GAME_STATES.RESULT:

            return resultOutcome === RESULT_OUTCOMES.LOST
                ? PLAYER_UI_STATES.LOST
                : PLAYER_UI_STATES.WIN;

        default:

            return PLAYER_UI_STATES.READY;

    }

}

export function isValidPlayerUIState(state) {

    return Object.values(PLAYER_UI_STATES).includes(state);

}

export function createDefaultPlayerRecord({
    id,
    nickname,
    icon,
    online = true,
    state = PLAYER_UI_STATES.READY
}) {

    return {
        id,
        nickname,
        icon,
        online,
        state,
        activityState: state
    };

}
