/**
 * A stale phase deadline triggers at most one authenticated recovery request
 * per (gameId, phase, endsAt) on the caller side. This is display recovery,
 * not a gameplay timer, local phase transition, or physics prediction.
 */
export const STALE_GAMEPLAY_PHASE_GRACE_MS = 2500;

const ACTIVE_PHASES = new Set([
    "READY",
    "SELF_TEST",
    "SPEED",
    "BRAKE",
    "RESULT"
]);

export function shouldRequestStaleGameplayPhaseRecovery({
    currentPage,
    gameplayPage,
    phase,
    gameId,
    clockGameId,
    endsAt,
    now,
    connected,
    recoveryInFlight
} = {}) {

    return currentPage === gameplayPage
        && connected === true
        && recoveryInFlight !== true
        && Boolean(gameId)
        && clockGameId === gameId
        && ACTIVE_PHASES.has(phase)
        && Number.isFinite(endsAt)
        && Number.isFinite(now)
        && now >= endsAt + STALE_GAMEPLAY_PHASE_GRACE_MS;

}
