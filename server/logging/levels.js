/**
 * R7.0D — Logging levels and profile defaults.
 */

export const LOG_LEVELS = Object.freeze({
    FATAL: "fatal",
    ERROR: "error",
    WARN: "warn",
    INFO: "info",
    DEBUG: "debug",
    TRACE: "trace"
});

/** Lower number = more severe. Records emit when priority <= configured minimum. */
export const LOG_LEVEL_PRIORITY = Object.freeze({
    [LOG_LEVELS.FATAL]: 0,
    [LOG_LEVELS.ERROR]: 1,
    [LOG_LEVELS.WARN]: 2,
    [LOG_LEVELS.INFO]: 3,
    [LOG_LEVELS.DEBUG]: 4,
    [LOG_LEVELS.TRACE]: 5
});

export const LOG_CHANNELS = Object.freeze({
    APPLICATION: "application",
    AUDIT: "audit"
});

export const LOG_FORMATS = Object.freeze({
    JSON: "json",
    CONSOLE: "console"
});

/**
 * Profile → default minimum level when LOG_LEVEL unset.
 * development: TRACE, staging: DEBUG, production: INFO
 */
export function defaultLogLevelForProfile(profile) {

    if (profile === "production") {

        return LOG_LEVELS.INFO;

    }

    if (profile === "staging") {

        return LOG_LEVELS.DEBUG;

    }

    return LOG_LEVELS.TRACE;

}

export function normalizeLogLevel(raw, fallback = LOG_LEVELS.INFO) {

    if (raw == null || raw === "") {

        return fallback;

    }

    const level = String(raw).trim().toLowerCase();

    return Object.values(LOG_LEVELS).includes(level) ? level : fallback;

}

export function shouldEmit(level, minimumLevel) {

    const recordPriority = LOG_LEVEL_PRIORITY[level]
        ?? LOG_LEVEL_PRIORITY[LOG_LEVELS.INFO];

    const minPriority = LOG_LEVEL_PRIORITY[minimumLevel]
        ?? LOG_LEVEL_PRIORITY[LOG_LEVELS.INFO];

    return recordPriority <= minPriority;

}
