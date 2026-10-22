export const SOCKET_CONNECTION_STATES = Object.freeze({
    DISCONNECTED: "DISCONNECTED",
    CONNECTING: "CONNECTING",
    CONNECTED: "CONNECTED",
    RECONNECTING: "RECONNECTING"
});

export const OUTGOING_SOCKET_EVENTS = Object.freeze({
    PLAYER_READY: "PLAYER_READY",
    PLAYER_READY_CONFIRM: "PLAYER_READY_CONFIRM",
    BUTTON_PRESS: "BUTTON_PRESS",
    BUTTON_RELEASE: "BUTTON_RELEASE",
    PING: "PING",
    PONG: "PONG",
    CLIENT_CONNECTED: "CLIENT_CONNECTED",
    CLIENT_DISCONNECTED: "CLIENT_DISCONNECTED",
    SESSION_RECOVERY_REQUEST: "SESSION_RECOVERY_REQUEST",
    // P6.7 — Page4 requests its own authoritative payment status after
    // mounting so it never stays stale when the original
    // ENTRY_PAYMENT_SESSION_UPDATED event was emitted before the page
    // subscribed. The server resolves identity from the socket→player
    // binding and re-derives the status from the authoritative payment
    // runtime; the client payload is never trusted.
    PAYMENT_STATUS_REQUEST: "PAYMENT_STATUS_REQUEST"
});

export const INCOMING_SOCKET_EVENTS = Object.freeze({
    GAME_STATE: "GAME_STATE",
    GAME_CLOCK_UPDATE: "GAME_CLOCK_UPDATE",
    PLAYER_UPDATE: "PLAYER_UPDATE",
    PLAYER_ONLINE: "PLAYER_ONLINE",
    PLAYER_OFFLINE: "PLAYER_OFFLINE",
    WHEEL_CONFIGURATION: "WHEEL_CONFIGURATION",
    PHYSICS_UPDATE: "PHYSICS_UPDATE",
    GAME_RESULT: "GAME_RESULT",
    GAME_START: "GAME_START",
    GAME_END: "GAME_END",
    SETUP_SESSION_STARTED: "SETUP_SESSION_STARTED",
    SETUP_SESSION_SYNC: "SETUP_SESSION_SYNC",
    SETUP_SESSION_EXPIRED: "SETUP_SESSION_EXPIRED",
    VERIFY_COMPLETED: "VERIFY_COMPLETED",
    PAYMENT_STAGE_READY: "PAYMENT_STAGE_READY",
    // Initial payment request is only a notification; Page4 re-reads status.
    PAYMENT_REQUEST: "PAYMENT_REQUEST",
    // P6.7 — authoritative per-player entry-payment status (Page4).
    ENTRY_PAYMENT_SESSION_UPDATED: "ENTRY_PAYMENT_SESSION_UPDATED",
    // P6.7 — server-owned start gate (Page4 waits; Page5 only on OPEN_PAGE5).
    GAME_START_AUTHORIZED: "GAME_START_AUTHORIZED",
    GAME_INITIALIZING: "GAME_INITIALIZING",
    OPEN_PAGE5: "OPEN_PAGE5",
    OPEN_PAGE6: "OPEN_PAGE6",
    SESSION_FINISHED: "SESSION_FINISHED",
    PING: "PING",
    PONG: "PONG",
    SESSION_SNAPSHOT: "SESSION_SNAPSHOT",
    SESSION_RECOVERY_FAILED: "SESSION_RECOVERY_FAILED",
    PLAYER_INPUT_ACCEPTED: "PLAYER_INPUT_ACCEPTED",
    PLAYER_INPUT_REJECTED: "PLAYER_INPUT_REJECTED",
    PRE_GAME_READY_STARTED: "PRE_GAME_READY_STARTED",
    PRE_GAME_READY_UPDATED: "PRE_GAME_READY_UPDATED",
    PRE_GAME_READY_COMPLETED: "PRE_GAME_READY_COMPLETED"
});

export const SOCKET_MESSAGE_CHANNEL = "game:message";

/"R1.3D — lobby client command (raw socket emit, not game:message). */
export const LOBBY_OUTGOING_EVENTS = Object.freeze({
    DEBUG_START_GAME: "DEBUG_START_GAME",
    /** R6.4 — leave the finished room before client session reset. */
    LEAVE_ROOM: "leaveRoom",
    /** R12.5G — observation-only Page6 / InfoBar client diagnostics. */
    PAGE6_CLIENT_DIAG: "PAGE6_CLIENT_DIAG"
});
