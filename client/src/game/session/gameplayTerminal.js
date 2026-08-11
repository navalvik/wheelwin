import { APP_PAGES } from "../sessionRecovery/recoveryFlow";

/** Pre-game pages covered by setupSessionExpiry (unchanged). */
export { shouldNavigateOnSetupSessionExpiry } from "./setupSessionExpiry.js";

/** Grace before Page5 requests recovery for missing wheel configuration. */
export const PAGE5_CONFIG_HYDRATION_GRACE_MS = 1500;

/**
 * R12.2 / R12.5H — Post-game roomClosed backup for active Page5 only.
 * Page6 exit is FINISH-only; Result Session expiry / roomClosed must not
 * auto-navigate an already displayed Page6.
 * Requires authoritative gameStarted (preGameEnded) so pre-game closures
 * keep using setupSessionExpiry semantics.
 */
export function shouldNavigateOnGameplayRoomClosed(currentPage, gameStarted) {

    if (!gameStarted) {

        return false;

    }

    return currentPage === APP_PAGES.GAMEPLAY;

}

/**
 * Lightweight terminal navigation diagnostic (no secrets / financial data).
 */
export function logTerminalNav({
    event,
    currentPage = null,
    sessionGeneration = null,
    skipped = false
}) {

    console.info("[TerminalNav]", {
        event,
        currentPage,
        sessionGeneration,
        skipped
    });

}
