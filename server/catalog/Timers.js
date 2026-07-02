export const TIMER_PHASES = Object.freeze({
    COUNTDOWN: "COUNTDOWN",
    SELF_TEST: "SELF_TEST",
    SPEED: "SPEED",
    BRAKE: "BRAKE",
    RESULT: "RESULT"
});

export const TIMERS = Object.freeze({
    [TIMER_PHASES.COUNTDOWN]: Object.freeze({
        phase: TIMER_PHASES.COUNTDOWN,
        durationMs: 3000
    }),
    [TIMER_PHASES.SELF_TEST]: Object.freeze({
        phase: TIMER_PHASES.SELF_TEST,
        durationMs: 2000
    }),
    [TIMER_PHASES.SPEED]: Object.freeze({
        phase: TIMER_PHASES.SPEED,
        durationMs: null
    }),
    [TIMER_PHASES.BRAKE]: Object.freeze({
        phase: TIMER_PHASES.BRAKE,
        durationMs: 3000
    }),
    [TIMER_PHASES.RESULT]: Object.freeze({
        phase: TIMER_PHASES.RESULT,
        durationMs: 5000
    })
});
