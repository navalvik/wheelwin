export const DEV_MODE = import.meta.env.DEV;

/** R6.0B — Developer Console availability (Vite development builds). */
export const DEV_CONSOLE_ENABLED = DEV_MODE;

/**
 * Temporary alias for DEV_CONSOLE_ENABLED.
 * Prefer DEV_CONSOLE_ENABLED in new code.
 */
export const DEV_DASHBOARD_ENABLED = DEV_CONSOLE_ENABLED;

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
