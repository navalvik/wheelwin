const DEFAULT_SETUP_DURATION_MS = 10 * 60 * 1000;

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

    return {
        maxPlayers,
        setupDurationMs
    };

}
