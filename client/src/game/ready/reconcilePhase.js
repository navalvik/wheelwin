import { GAME_STATES } from "../GameState.js";

// Monotonic server-authoritative phase ordering. The clock is already
// authoritative and sent periodically; using it as a fallback does not
// create a local timer or a new gameplay decision.
export const SERVER_PHASE_ORDER = Object.freeze([
    GAME_STATES.PRE_GAME_READY, GAME_STATES.READY, GAME_STATES.SELF_TEST,
    GAME_STATES.SPEED, GAME_STATES.BRAKE, GAME_STATES.RESULT
]);

export function serverPhaseRank(phase) {
    return SERVER_PHASE_ORDER.indexOf(phase);
}

/**
 * Recover a missed GAME_STATE broadcast using the server's periodic
 * GAME_CLOCK_UPDATE. Never rewind or cross into another active game.
 */
export function canAdvanceFromServerClock(payload, tracked) {
    const rank = serverPhaseRank(payload?.phase);
    if (rank < 0 || !payload?.gameId) return false;
    if (tracked?.gameId && tracked.gameId !== payload.gameId) return false;
    const previousRank = tracked?.phaseRank;
    return previousRank === null || previousRank === undefined
        || (Number.isInteger(previousRank) && rank > previousRank);
}
