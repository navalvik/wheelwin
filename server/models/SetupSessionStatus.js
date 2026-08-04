/**
 * C5.6C — Setup Session lifecycle states.
 *
 * Orthogonal to GameStateEngine / GAME_STATES. Never written into gameplay.
 */
export const SETUP_SESSION_STATUS = Object.freeze({
    CREATED: "CREATED",
    ACTIVE: "ACTIVE",
    COMPLETED: "COMPLETED",
    // R6.38 — Ownership handed to payment; timer cleared; no destroy authority.
    ARCHIVED: "ARCHIVED",
    EXPIRED: "EXPIRED",
    ABORTED: "ABORTED"
});
