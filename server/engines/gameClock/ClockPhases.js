import { TIMER_PHASES } from "../../catalog/Timers.js";

export const CLOCK_PHASE_SEQUENCE = Object.freeze([
    TIMER_PHASES.COUNTDOWN,
    TIMER_PHASES.SELF_TEST,
    TIMER_PHASES.SPEED,
    TIMER_PHASES.BRAKE,
    TIMER_PHASES.RESULT
]);

export function getNextClockPhase(currentPhase) {

    const index = CLOCK_PHASE_SEQUENCE.indexOf(currentPhase);

    if (index === -1 || index >= CLOCK_PHASE_SEQUENCE.length - 1) {

        return null;

    }

    return CLOCK_PHASE_SEQUENCE[index + 1];

}
