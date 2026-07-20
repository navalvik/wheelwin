import { GAME_STATES } from "../GameState";

export const BUTTON_STATES = Object.freeze({
    READY: "READY",
    PUSH: "PUSH",
    COUNTDOWN: "COUNTDOWN",
    SPEED: "SPEED",
    BRAKE: "BRAKE",
    WIN: "WIN",
    LOST: "LOST"
});

export const RESULT_OUTCOMES = Object.freeze({
    WIN: "WIN",
    LOST: "LOST"
});

export const MAX_BUTTON_PRESSES = 3;

export const BUTTON_PRESENTATION = Object.freeze({
    [BUTTON_STATES.READY]: {
        label: "READY",
        backgroundColor: "#bbbbbb",
        borderColor: "#999999",
        textColor: "#000000",
        pulseClass: "centerButton--pulseReady"
    },
    [BUTTON_STATES.PUSH]: {
        label: "PUSH",
        backgroundColor: "#222222",
        borderColor: "#1c73d0",
        textColor: "#ffffff",
        pulseClass: "centerButton--pulsePush"
    },
    [BUTTON_STATES.COUNTDOWN]: {
        label: "COUNTDOWN",
        backgroundColor: "#666666",
        borderColor: "#4f8dd8",
        textColor: "#ffffff",
        pulseClass: "centerButton--pulseCountdown"
    },
    [BUTTON_STATES.SPEED]: {
        label: "SPEED",
        backgroundColor: "#00aa44",
        borderColor: "#008833",
        textColor: "#ffffff",
        pulseClass: "centerButton--pulseSpeed"
    },
    [BUTTON_STATES.BRAKE]: {
        label: "BRAKE",
        backgroundColor: "#e67e00",
        borderColor: "#c96d00",
        textColor: "#ffffff",
        pulseClass: "centerButton--pulseBrake"
    },
    [BUTTON_STATES.WIN]: {
        label: "WIN",
        backgroundColor: "#00aa44",
        borderColor: "#008833",
        textColor: "#ffffff",
        pulseClass: ""
    },
    [BUTTON_STATES.LOST]: {
        label: "LOST",
        backgroundColor: "#d62828",
        borderColor: "#b81f1f",
        textColor: "#ffffff",
        pulseClass: ""
    }
});

export function mapGameStateToButtonState(gameState, resultOutcome) {

    switch (gameState) {

        case GAME_STATES.READY:
        case GAME_STATES.SELF_TEST:

            return BUTTON_STATES.READY;

        case GAME_STATES.SPEED:

            return BUTTON_STATES.SPEED;

        case GAME_STATES.BRAKE:

            return BUTTON_STATES.BRAKE;

        case GAME_STATES.RESULT:

            return resultOutcome === RESULT_OUTCOMES.LOST
                ? BUTTON_STATES.LOST
                : BUTTON_STATES.WIN;

        default:

            return BUTTON_STATES.PUSH;

    }

}

export function isButtonStateInteractive(buttonState) {

    return buttonState === BUTTON_STATES.PUSH
        || buttonState === BUTTON_STATES.SPEED
        || buttonState === BUTTON_STATES.BRAKE;

}
