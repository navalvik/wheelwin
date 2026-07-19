const DEFAULT_GAMEPLAY_DURATION_MS = 5 * 60 * 1000;

const DEFAULT_GAMEPLAY_WARNING_MS = 30 * 1000;

/**
 * R1.3C — Gameplay Timer configuration (Timer 2 wall clock).
 */
export function loadGameplayTimerConfig(env = process.env) {

    const durationMs = env.GAMEPLAY_DURATION_MS === undefined
        ? DEFAULT_GAMEPLAY_DURATION_MS
        : Number(env.GAMEPLAY_DURATION_MS);

    if (!Number.isFinite(durationMs) || durationMs <= 0) {

        throw new Error("Invalid GAMEPLAY_DURATION_MS environment variable");

    }

    const warningMs = env.GAMEPLAY_WARNING_MS === undefined
        ? DEFAULT_GAMEPLAY_WARNING_MS
        : Number(env.GAMEPLAY_WARNING_MS);

    if (!Number.isFinite(warningMs) || warningMs < 0) {

        throw new Error("Invalid GAMEPLAY_WARNING_MS environment variable");

    }

    if (warningMs >= durationMs) {

        throw new Error(
            "GAMEPLAY_WARNING_MS must be less than GAMEPLAY_DURATION_MS"
        );

    }

    return {
        gameplayDurationMs: durationMs,
        gameplayWarningMs: warningMs
    };

}

export {
    DEFAULT_GAMEPLAY_DURATION_MS,
    DEFAULT_GAMEPLAY_WARNING_MS
};
