/** Pre-game pages that must return to Page1 when Setup Session expires. */
export const SETUP_EXPIRY_NAVIGATION_MIN_PAGE = 3;

export const SETUP_EXPIRY_NAVIGATION_MAX_EXCLUSIVE_PAGE = 7;

/**
 * Whether SETUP_SESSION_EXPIRED / roomClosed should navigate this client to Page1.
 * Covers PLAYER_SETUP through PAYMENT (pages 3–6).
 */
export function shouldNavigateOnSetupSessionExpiry(currentPage) {

    return currentPage >= SETUP_EXPIRY_NAVIGATION_MIN_PAGE
        && currentPage < SETUP_EXPIRY_NAVIGATION_MAX_EXCLUSIVE_PAGE;

}
