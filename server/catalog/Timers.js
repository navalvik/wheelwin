import { GAME_STATES } from "../engines/gameState/GameStates.js";

export const TIMER_PHASES = Object.freeze({
    PRE_GAME_READY: GAME_STATES.PRE_GAME_READY,
    READY: GAME_STATES.READY,
    SELF_TEST: GAME_STATES.SELF_TEST,
    SPEED: GAME_STATES.SPEED,
    BRAKE: GAME_STATES.BRAKE,
    RESULT: GAME_STATES.RESULT
});

/**
 * Default catalog timers. Runtime values are supplied by loadGameplayPhaseConfig()
 * via GameCatalog.configurePhaseTimers() during server bootstrap.
 */
export const TIMERS = Object.freeze({
    [TIMER_PHASES.PRE_GAME_READY]: Object.freeze({
        phase: TIMER_PHASES.PRE_GAME_READY,
        // TEMP R7.70C2.7 diagnostic: 360000 (was 180000). Revert after Testnet validation.
        durationMs: 360000
    }),
    [TIMER_PHASES.READY]: Object.freeze({
        phase: TIMER_PHASES.READY,
        durationMs: 3000
    }),
    [TIMER_PHASES.SELF_TEST]: Object.freeze({
        phase: TIMER_PHASES.SELF_TEST,
        durationMs: 1500
    }),
    [TIMER_PHASES.SPEED]: Object.freeze({
        phase: TIMER_PHASES.SPEED,
        durationMs: 8000
    }),
    [TIMER_PHASES.BRAKE]: Object.freeze({
        phase: TIMER_PHASES.BRAKE,
        durationMs: 6000
    }),
    [TIMER_PHASES.RESULT]: Object.freeze({
        phase: TIMER_PHASES.RESULT,
        durationMs: 4000
    })
});
