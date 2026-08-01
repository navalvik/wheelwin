export const DEV_MODE = import.meta.env.DEV;

/**
 * R6.0B / R7.1 — Developer Console route availability.
 * Enabled in Vite DEV builds, and in production only when
 * VITE_DEV_CONSOLE_ENABLED=true (auth still required).
 */
export const DEV_CONSOLE_ENABLED = DEV_MODE
    || import.meta.env.VITE_DEV_CONSOLE_ENABLED === "true";

/**
 * Temporary alias for DEV_CONSOLE_ENABLED.
 * Prefer DEV_CONSOLE_ENABLED in new code.
 */
export const DEV_DASHBOARD_ENABLED = DEV_CONSOLE_ENABLED;

/**
 * ------------------------------------------------------------
 * Developer Stub
 *
 * Temporary navigation used during development.
 * Disabled for production.
 * Can be re-enabled by setting
 * DEBUG_JUMP_ENABLED = true
 * ------------------------------------------------------------
 */
export const DEBUG_JUMP_ENABLED = false;

export const DEV_PAGE_SEQUENCE = [
    1, // Page1Welcome
    2, // RoomLobby
    3, // Page2PlayerSetup
    4, // PageMatrix
    5, // Page3Verify
    6, // Page4Payment
    7, // Page5Game
    8  // Page6Result
];
