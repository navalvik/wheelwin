import { GAME_STATES, GAME_STATE_SEQUENCE } from "../engines/gameState/GameStates.js";

/**
 * P5.3 — Immutable Page5 gameplay phase sequence.
 *
 * PAGE5_OPEN (navigation) → READY → SELF_TEST → SPEED → BRAKE → RESULT → PAGE6
 * Only READY…RESULT are GameStates; PAGE5_OPEN / PAGE6 are navigation surfaces.
 */
export const GAMEPLAY_PHASE_SEQUENCE = GAME_STATE_SEQUENCE;

export function getNextGameplayPhase(currentPhase) {

    const index = GAMEPLAY_PHASE_SEQUENCE.indexOf(currentPhase);

    if (index === -1 || index >= GAMEPLAY_PHASE_SEQUENCE.length - 1) {

        return null;

    }

    return GAMEPLAY_PHASE_SEQUENCE[index + 1];

}

export function getPhaseStartedEventType(phase) {

    return `${phase}_STARTED`;

}

export function getPhaseCompletedEventType(phase) {

    return `${phase}_COMPLETED`;

}

export function isOfficialGameplayPhase(phase) {

    return GAMEPLAY_PHASE_SEQUENCE.includes(phase);

}

export function validateGameplayPhaseSequence() {

    const expected = [
        GAME_STATES.READY,
        GAME_STATES.SELF_TEST,
        GAME_STATES.SPEED,
        GAME_STATES.BRAKE,
        GAME_STATES.RESULT
    ];

    if (GAMEPLAY_PHASE_SEQUENCE.length !== expected.length) {

        throw new Error("Gameplay phase sequence length mismatch");

    }

    for (let index = 0; index < expected.length; index += 1) {

        if (GAMEPLAY_PHASE_SEQUENCE[index] !== expected[index]) {

            throw new Error(
                `Gameplay phase sequence mismatch at index ${index}`
            );

        }

    }

}
