export const DEV_MODE = import.meta.env.DEV;

export const DEV_DASHBOARD_ENABLED = DEV_MODE;

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
