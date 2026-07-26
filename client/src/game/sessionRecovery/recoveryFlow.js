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
 */
export function resolveGameplayRecoveryPage(snapshot) {

    if (!snapshot) {

        return null;

    }

    // Page6 only after authoritative OPEN_PAGE6.
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
