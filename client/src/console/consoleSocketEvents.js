/**
 * R6.0D — Client mirror of server/console/consoleProtocol.js
 * Namespace `/console` only — never the gameplay socket.
 */

export const CONSOLE_NAMESPACE = "/console";

export const CONSOLE_CLIENT_EVENTS = Object.freeze({
    SUBSCRIBE: "CONSOLE_SUBSCRIBE",
    FOCUS: "CONSOLE_FOCUS",
    UNSUBSCRIBE: "CONSOLE_UNSUBSCRIBE"
});

export const CONSOLE_SERVER_EVENTS = Object.freeze({
    CONNECTED: "CONSOLE_CONNECTED",
    SERVER: "CONSOLE_SERVER",
    ROOMS: "CONSOLE_ROOMS",
    ROOM: "CONSOLE_ROOM",
    GAME: "CONSOLE_GAME",
    PLAYERS: "CONSOLE_PLAYERS",
    PAYMENTS: "CONSOLE_PAYMENTS",
    RECOVERY: "CONSOLE_RECOVERY",
    SIMULATION: "CONSOLE_SIMULATION",
    METRICS: "CONSOLE_METRICS",
    LOG: "CONSOLE_LOG"
});

export const CONSOLE_CONNECTION_STATES = Object.freeze({
    DISCONNECTED: "DISCONNECTED",
    CONNECTING: "CONNECTING",
    CONNECTED: "CONNECTED",
    RECONNECTING: "RECONNECTING"
});

export const CONSOLE_SOCKET_URL =
    (import.meta.env.VITE_SOCKET_URL || "http://localhost:3001")
    + CONSOLE_NAMESPACE;
