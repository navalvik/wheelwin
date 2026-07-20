import {
    BUTTON_PRESENTATION,
    BUTTON_STATES,
    MAX_BUTTON_PRESSES,
    isButtonStateInteractive,
    mapGameStateToButtonState
} from "./ButtonState";

import { GAME_STATES } from "../GameState";

export class CentralButtonEngine {

    constructor() {

        this._state = BUTTON_STATES.PUSH;

        this._enabled = true;

        this._locked = false;

        this._pressCount = 0;

        this._isPressed = false;

        this._resultOutcome = null;

        this._transmitAlways = false;

        this._presentation = this._buildPresentation();

        this._stateListeners = new Set();

        this._eventListeners = new Set();

    }

    reset() {

        this._state = BUTTON_STATES.PUSH;

        this._enabled = true;

        this._locked = false;

        this._pressCount = 0;

        this._isPressed = false;

        this._resultOutcome = null;

        this._transmitAlways = false;

        this._refreshPresentation();

        this._notifyState();

    }

    setState(buttonState) {

        const previousState = this._state;

        this._state = buttonState;

        if (buttonState === BUTTON_STATES.SPEED && previousState !== BUTTON_STATES.SPEED) {

            this._pressCount = 0;

            this._locked = false;

        }

        if (buttonState === BUTTON_STATES.WIN
            || buttonState === BUTTON_STATES.LOST) {

            this.disable();

        } else if (isButtonStateInteractive(buttonState) && !this._locked) {

            this.enable();

        } else {

            this.disable();

        }

        this._refreshPresentation();

        this._notifyState();

    }

    syncWithGameState(gameState, resultOutcome = null) {

        this._resultOutcome = resultOutcome;

        const nextState = mapGameStateToButtonState(gameState, resultOutcome);

        this.setState(nextState);

    }

    setResultOutcome(outcome) {

        this._resultOutcome = outcome;

        if (this._state === BUTTON_STATES.WIN
            || this._state === BUTTON_STATES.LOST) {

            this.setState(
                mapGameStateToButtonState(GAME_STATES.RESULT, outcome)
            );

        }

    }

    restoreSessionSnapshot(snapshot = {}) {

        const button = snapshot.button || snapshot.pressCounters || snapshot;

        const pressCounter = button.pressCounter
            ?? button.completedCycles
            ?? button.pressCount
            ?? this._pressCount;

        const nextState = button.currentState
            ?? button.state
            ?? this._state;

        this._state = nextState;

        this._pressCount = Math.max(0, pressCounter);

        // Reconnect never restores a held press — server RELEASE-on-disconnect
        // guarantees pressed is false after offline mid-hold.
        this._isPressed = button.pressed === true
            || button.buttonPressed === true;

        this._locked = button.buttonLocked === true
            || button.locked === true
            || this._pressCount >= MAX_BUTTON_PRESSES;

        if (button.enabled === false || this._locked) {

            this._enabled = false;

        } else if (button.enabled === true) {

            this._enabled = true;

        } else if (isButtonStateInteractive(nextState) && !this._locked) {

            this._enabled = true;

        }

        if (nextState === BUTTON_STATES.WIN
            || nextState === BUTTON_STATES.LOST
            || this._locked) {

            this._enabled = false;

        }

        this._refreshPresentation();

        this._notifyState();

    }

    /**
     * P5.6B — Apply authoritative SPEED input sync (ack / recovery).
     * Clients display server state only; local counters are overwritten.
     */
    applyAuthoritativeInput(payload = {}) {

        if (payload.pressCount !== undefined
            || payload.completedCycles !== undefined) {

            this._pressCount = Math.max(
                0,
                payload.completedCycles ?? payload.pressCount
            );

        }

        if (payload.pressed !== undefined
            || payload.buttonPressed !== undefined) {

            this._isPressed = payload.pressed === true
                || payload.buttonPressed === true;

        }

        if (payload.buttonLocked !== undefined
            || payload.locked !== undefined) {

            this._locked = payload.buttonLocked === true
                || payload.locked === true;

        } else if (this._pressCount >= MAX_BUTTON_PRESSES) {

            this._locked = true;

        }

        if (this._locked) {

            this._enabled = false;

            this._isPressed = false;

        } else if (isButtonStateInteractive(this._state)) {

            this._enabled = true;

        }

        this._refreshPresentation();

        this._notifyState();

    }

    enable() {

        if (this._locked) {

            return;

        }

        this._enabled = true;

        this._refreshPresentation();

        this._notifyState();

    }

    disable() {

        this._enabled = false;

        this._refreshPresentation();

        this._notifyState();

    }

    setTransmitAlways(enabled) {

        this._transmitAlways = Boolean(enabled);

        this._refreshPresentation();

        this._notifyState();

    }

    press() {

        if (!this._transmitAlways
            && (!this._enabled || this._locked || this._isPressed)) {

            return false;

        }

        if (this._locked || this._isPressed) {

            return false;

        }

        this._isPressed = true;

        this._emitEvent({
            type: "press",
            buttonState: this._state,
            pressCount: this._pressCount
        });

        return true;

    }

    release() {

        if (!this._isPressed) {

            return false;

        }

        this._isPressed = false;

        if (this._state === BUTTON_STATES.SPEED
            || this._state === BUTTON_STATES.BRAKE) {

            this._pressCount += 1;

            if (this._pressCount >= MAX_BUTTON_PRESSES) {

                this._locked = true;

                this.disable();

            }

        }

        this._emitEvent({
            type: "release",
            buttonState: this._state,
            pressCount: this._pressCount,
            locked: this._locked
        });

        this._refreshPresentation();

        this._notifyState();

        return true;

    }

    getPressCount() {

        return this._pressCount;

    }

    getState() {

        return this._state;

    }

    getPresentation() {

        return this._presentation;

    }

    isEnabled() {

        return this._enabled;

    }

    isLocked() {

        return this._locked;

    }

    isPressed() {

        return this._isPressed;

    }

    subscribe(listener) {

        this._stateListeners.add(listener);

        listener(this.getSnapshot());

        return () => {

            this._stateListeners.delete(listener);

        };

    }

    onEvent(listener) {

        this._eventListeners.add(listener);

        return () => {

            this._eventListeners.delete(listener);

        };

    }

    getSnapshot() {

        return {
            state: this._state,
            presentation: this._presentation,
            pressCount: this._pressCount,
            completedCycles: this._pressCount,
            remainingPresses: Math.max(0, MAX_BUTTON_PRESSES - this._pressCount),
            enabled: this._enabled,
            locked: this._locked,
            buttonLocked: this._locked,
            isPressed: this._isPressed
        };

    }

    _buildPresentation() {

        if (this._locked) {

            const lockedTheme = BUTTON_PRESENTATION[BUTTON_STATES.LOCKED];

            return {
                state: BUTTON_STATES.LOCKED,
                label: lockedTheme.label,
                backgroundColor: lockedTheme.backgroundColor,
                borderColor: lockedTheme.borderColor,
                textColor: lockedTheme.textColor,
                pulseClass: "",
                enabled: false,
                locked: true,
                pressCount: this._pressCount
            };

        }

        const theme = BUTTON_PRESENTATION[this._state]
            || BUTTON_PRESENTATION[BUTTON_STATES.PUSH];

        return {
            state: this._state,
            label: theme.label,
            backgroundColor: theme.backgroundColor,
            borderColor: theme.borderColor,
            textColor: theme.textColor,
            pulseClass: theme.pulseClass,
            enabled: this._transmitAlways || this._enabled,
            locked: this._locked,
            pressCount: this._pressCount
        };

    }

    _refreshPresentation() {

        this._presentation = this._buildPresentation();

    }

    _notifyState() {

        const snapshot = this.getSnapshot();

        this._stateListeners.forEach((listener) => {

            listener(snapshot);

        });

    }

    _emitEvent(event) {

        this._eventListeners.forEach((listener) => {

            listener(event);

        });

    }

}
