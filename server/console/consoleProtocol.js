/**
 * R6.0D — Developer Console Socket.IO protocol (namespace `/console`).
 *
 * Independent of gameplay `game:message` and lobby events.
 */

export const CONSOLE_NAMESPACE = "/console";

/** Client → server */
export const CONSOLE_CLIENT_EVENTS = Object.freeze({
    SUBSCRIBE: "CONSOLE_SUBSCRIBE",
    FOCUS: "CONSOLE_FOCUS",
    UNSUBSCRIBE: "CONSOLE_UNSUBSCRIBE"
});

/** Server → client */
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

/** Update intervals (ms) */
export const CONSOLE_UPDATE_POLICY = Object.freeze({
    SERVER_MS: 1000,
    METRICS_MS: 3000,
    LOW_FREQUENCY_MS: 5000,
    FOCUS_HIGH_FREQUENCY_MS: 250,
    ROOMS_DEBOUNCE_MS: 100,
    LOG_BUFFER_SIZE: 100
});

/**
 * Build a console message envelope.
 * @param {string} type
 * @param {object|null} payload
 */
export function buildConsoleEnvelope(type, payload = null) {

    return Object.freeze({
        type,
        payload,
        sentAt: Date.now()
    });

}
