const DEFAULT_SETUP_DURATION_MS = 10 * 60 * 1000;

/** R6.5 — Page6 result linger before authoritative SESSION_FINISHED. */
const DEFAULT_RESULT_SESSION_DURATION_MS = 5 * 60 * 1000;

/** P6.3 — Payment Session wall-clock before authoritative failure. */
const DEFAULT_PAYMENT_SESSION_DURATION_MS = 5 * 60 * 1000;

const DEFAULT_MAX_CONCURRENT_ROOMS = 64;

export function loadRoomConfig(env = process.env) {

    const maxPlayers = Number(env.ROOM_MAX_PLAYERS);

    if (!Number.isFinite(maxPlayers) || maxPlayers <= 0) {

        throw new Error("Invalid ROOM_MAX_PLAYERS environment variable");

    }

    const setupDurationMs = env.SETUP_DURATION_MS === undefined
        ? DEFAULT_SETUP_DURATION_MS
        : Number(env.SETUP_DURATION_MS);

    if (!Number.isFinite(setupDurationMs) || setupDurationMs <= 0) {

        throw new Error("Invalid SETUP_DURATION_MS environment variable");

    }

    const resultSessionDurationMs = env.RESULT_SESSION_DURATION_MS === undefined
        ? DEFAULT_RESULT_SESSION_DURATION_MS
        : Number(env.RESULT_SESSION_DURATION_MS);

    if (!Number.isFinite(resultSessionDurationMs) || resultSessionDurationMs <= 0) {

        throw new Error("Invalid RESULT_SESSION_DURATION_MS environment variable");

    }

    const paymentSessionDurationMs = env.PAYMENT_SESSION_DURATION_MS === undefined
        ? DEFAULT_PAYMENT_SESSION_DURATION_MS
        : Number(env.PAYMENT_SESSION_DURATION_MS);

    if (!Number.isFinite(paymentSessionDurationMs) || paymentSessionDurationMs <= 0) {

        throw new Error("Invalid PAYMENT_SESSION_DURATION_MS environment variable");

    }

    const maxConcurrentRooms = env.ROOM_MAX_CONCURRENT === undefined
        ? DEFAULT_MAX_CONCURRENT_ROOMS
        : Number(env.ROOM_MAX_CONCURRENT);

    if (!Number.isFinite(maxConcurrentRooms) || maxConcurrentRooms <= 0) {

        throw new Error("Invalid ROOM_MAX_CONCURRENT environment variable");

    }

    return {
        maxPlayers,
        setupDurationMs,
        resultSessionDurationMs,
        paymentSessionDurationMs,
        maxConcurrentRooms
    };

}
