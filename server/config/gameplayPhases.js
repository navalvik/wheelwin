import { GAME_STATES } from "../engines/gameState/GameStates.js";

export const DEFAULT_GAMEPLAY_PHASE_DURATIONS_MS = Object.freeze({
    [GAME_STATES.READY]: 3000,
    [GAME_STATES.SELF_TEST]: 1500,
    [GAME_STATES.SPEED]: 6000,
    [GAME_STATES.BRAKE]: 6000,
    [GAME_STATES.RESULT]: 4000
});

function parsePositiveDuration(value, fallback) {

    const parsed = Number(value);

    if (!Number.isFinite(parsed) || parsed <= 0) {

        return fallback;

    }

    return parsed;

}

export function loadGameplayPhaseConfig(env = process.env) {

    return Object.freeze({
        readyDurationMs: parsePositiveDuration(
            env.GAMEPLAY_READY_DURATION_MS,
            DEFAULT_GAMEPLAY_PHASE_DURATIONS_MS[GAME_STATES.READY]
        ),
        selfTestDurationMs: parsePositiveDuration(
            env.GAMEPLAY_SELF_TEST_DURATION_MS,
            DEFAULT_GAMEPLAY_PHASE_DURATIONS_MS[GAME_STATES.SELF_TEST]
        ),
        speedDurationMs: parsePositiveDuration(
            env.GAMEPLAY_SPEED_DURATION_MS,
            DEFAULT_GAMEPLAY_PHASE_DURATIONS_MS[GAME_STATES.SPEED]
        ),
        brakeDurationMs: parsePositiveDuration(
            env.GAMEPLAY_BRAKE_DURATION_MS,
            DEFAULT_GAMEPLAY_PHASE_DURATIONS_MS[GAME_STATES.BRAKE]
        ),
        resultDurationMs: parsePositiveDuration(
            env.GAMEPLAY_RESULT_DURATION_MS,
            DEFAULT_GAMEPLAY_PHASE_DURATIONS_MS[GAME_STATES.RESULT]
        )
    });

}

export function buildGameplayPhaseTimers(phaseConfig) {

    return Object.freeze({
        [GAME_STATES.READY]: Object.freeze({
            phase: GAME_STATES.READY,
            durationMs: phaseConfig.readyDurationMs
        }),
        [GAME_STATES.SELF_TEST]: Object.freeze({
            phase: GAME_STATES.SELF_TEST,
            durationMs: phaseConfig.selfTestDurationMs
        }),
        [GAME_STATES.SPEED]: Object.freeze({
            phase: GAME_STATES.SPEED,
            durationMs: phaseConfig.speedDurationMs
        }),
        [GAME_STATES.BRAKE]: Object.freeze({
            phase: GAME_STATES.BRAKE,
            durationMs: phaseConfig.brakeDurationMs
        }),
        [GAME_STATES.RESULT]: Object.freeze({
            phase: GAME_STATES.RESULT,
            durationMs: phaseConfig.resultDurationMs
        })
    });

}
