import { GAME_STATES } from "../GameState";

// App page numbers (see App.jsx renderPage switch).
export const APP_PAGES = Object.freeze({
    WELCOME: 1,
    LOBBY: 2,
    PLAYER_SETUP: 3,
    MATRIX: 4,
    VERIFY: 5,
    PAYMENT: 6,
    GAMEPLAY: 7,
    RESULT: 8
});

export const RECOVERY_UI_STATUS = Object.freeze({
    IDLE: "idle",
    RECONNECTING: "reconnecting",
    RESTORING: "restoring",
    COMPLETE: "complete",
    FAILED: "failed"
});

const PRE_GAME_PAGES = Object.freeze([
    APP_PAGES.PLAYER_SETUP,
    APP_PAGES.MATRIX,
    APP_PAGES.VERIFY,
    APP_PAGES.PAYMENT
]);

/** R6.1 — Pages that may reclaim an active Setup Session seat. */
const SETUP_RECOVERY_PAGES = Object.freeze([
    APP_PAGES.LOBBY,
    ...PRE_GAME_PAGES
]);

const GAMEPLAY_PAGES = Object.freeze([
    APP_PAGES.GAMEPLAY,
    APP_PAGES.RESULT
]);

const ACTIVE_GAMEPLAY_STATES = Object.freeze([
    GAME_STATES.PRE_GAME_READY,
    GAME_STATES.READY,
    GAME_STATES.SELF_TEST,
    GAME_STATES.SPEED,
    GAME_STATES.BRAKE
]);

export function isPreGamePage(page) {

    return PRE_GAME_PAGES.includes(page);

}

/** R6.1 — Lobby + prep pages while Setup Session owns the room. */
export function isSetupRecoveryPage(page) {

    return SETUP_RECOVERY_PAGES.includes(page);

}

export function isGameplayPage(page) {

    return GAMEPLAY_PAGES.includes(page);

}

/**
 * Pre-game recovery is valid only while an authoritative Setup Session timer
 * is still active (expiresAt in the future). Local timers never decide this.
 */
export function canRecoverPreGame(session, setup = null) {

    if (setup?.expiresAt) {

        return setup.expiresAt > Date.now();

    }

    return Boolean(
        session?.currentPhase
        && session.phaseTimeRemaining > 0
    );

}

/**
 * Determines the gameplay destination page strictly from the authoritative
 * recovery snapshot. The client never infers gameplay state locally.
 * Page6 requires openPage6 (OPEN_PAGE6) — never gameResult alone.
 *
 * R12.5H — openPage6 restores Page6 regardless of Result Session deadline.
 * Expiry no longer navigates Page6; FINISH is the client exit action.
 * Destroyed sessions still use terminal recovery failure → Page1.
 */
export function resolveGameplayRecoveryPage(snapshot, _now = Date.now()) {

    if (!snapshot) {

        return null;

    }

    // Authoritative Page6 was opened — restore Page6 (FINISH exits, not timer).
    if (snapshot.openPage6 === true) {

        return APP_PAGES.RESULT;

    }

    // During RESULT (4s) stay on Page5 with winner presentation.
    if (snapshot.gameState === GAME_STATES.RESULT) {

        return APP_PAGES.GAMEPLAY;

    }

    if (ACTIVE_GAMEPLAY_STATES.includes(snapshot.gameState)) {

        return APP_PAGES.GAMEPLAY;

    }

    return null;

}

export function hasGameplayIdentity(identity) {

    return Boolean(identity?.roomId && identity?.playerId);

}

/**
 * R6.17 — Only terminal server failures may wipe client session / go to Page1.
 * Local timers and transient recovery gaps must never reset the client.
 */
export const TERMINAL_RECOVERY_FAILURE_CODES = Object.freeze([
    "ROOM_NOT_FOUND",
    "PLAYER_NOT_FOUND",
    "SESSION_EXPIRED",
    "RECOVERY_STASH_MISSING"
]);

const TERMINAL_RECOVERY_FAILURE_PATTERNS = Object.freeze([
    /room[_ ]?(not found|session is not active)/i,
    /player[_ ]?(not found|does not exist|session is not recoverable)/i,
    /session[_ ]?expired/i,
    /stash/i,
    /claim does not match/i
]);

export function isTerminalRecoveryFailure(payload) {

    const code = String(
        payload?.code
        ?? payload?.errorCode
        ?? payload?.reasonCode
        ?? ""
    ).trim().toUpperCase();

    if (code && TERMINAL_RECOVERY_FAILURE_CODES.includes(code)) {

        return true;

    }

    const reason = String(
        payload?.reason
        ?? payload?.message
        ?? ""
    ).trim();

    if (!reason) {

        return false;

    }

    // Payment / lobby after setup: server may say no gameplay session — keep seat.
    if (/no active gameplay session for recovery/i.test(reason)) {

        return false;

    }

    return TERMINAL_RECOVERY_FAILURE_PATTERNS.some((pattern) => pattern.test(reason));

}

export function mapRecoveryStatusMessage(status) {

    switch (status) {

        case RECOVERY_UI_STATUS.RECONNECTING:

            return "Reconnecting…";

        case RECOVERY_UI_STATUS.RESTORING:

            return "Game restored";

        case RECOVERY_UI_STATUS.COMPLETE:

            return "Game restored";

        case RECOVERY_UI_STATUS.FAILED:

            return "Unable to restore game.";

        default:

            return null;

    }

}
