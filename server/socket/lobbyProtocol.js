export const LOBBY_CLIENT_EVENTS = Object.freeze({
    CREATE_ROOM: "createRoom",
    JOIN_ROOM: "joinRoom",
    LEAVE_ROOM: "leaveRoom",
    DISCONNECT: "disconnect",
    UPDATE_PLAYER_PROFILE: "updatePlayerProfile",
    SUBMIT_SECRET_MATRIX: "submitSecretMatrix",
    CONFIRM_VERIFY: "confirmVerify",
    VERIFY_NEXT_REQUEST: "VERIFY_NEXT_REQUEST",
    // R1.3D — development-only; SocketGateway rejects outside development.
    DEBUG_START_GAME: "DEBUG_START_GAME",
    // P6.2 — Telegram Wallet / TON Connect reports (connection only).
    WALLET_CONNECT_STARTED: "WALLET_CONNECT_STARTED",
    WALLET_CONNECT_REPORT: "WALLET_CONNECT_REPORT",
    WALLET_DISCONNECT_REPORT: "WALLET_DISCONNECT_REPORT",
    // P6.3 — player confirms the authoritative payment request (no chain yet).
    PAYMENT_CONFIRM_INTENT: "PAYMENT_CONFIRM_INTENT",
    // P6.5 — player cancelled Telegram Wallet payment confirmation.
    PAYMENT_CANCEL_INTENT: "PAYMENT_CANCEL_INTENT"
});

export const LOBBY_SERVER_EVENTS = Object.freeze({
    ROOM_CREATED: "roomCreated",
    ROOM_STATE: "roomState",
    ROOM_JOINED: "roomJoined",
    ROOM_LEFT: "roomLeft",
    ROOM_ERROR: "roomError",
    ROOM_CLOSED: "roomClosed",
    START_GAME: "startGame",
    SETUP_SESSION_STARTED: "SETUP_SESSION_STARTED",
    SETUP_SESSION_SYNC: "SETUP_SESSION_SYNC",
    SETUP_SESSION_EXPIRED: "SETUP_SESSION_EXPIRED",
    PLAYER_UPDATE: "PLAYER_UPDATE",
    SECRET_MATRIX_ACCEPTED: "SECRET_MATRIX_ACCEPTED",
    SECRET_MATRIX_REJECTED: "SECRET_MATRIX_REJECTED",
    VERIFY_COMPLETED: "VERIFY_COMPLETED",
    PAYMENT_STAGE_READY: "PAYMENT_STAGE_READY",
    ENTRY_PAYMENT_SESSION_UPDATED: "ENTRY_PAYMENT_SESSION_UPDATED",
    ENTRY_PAYMENT_COMPLETED: "ENTRY_PAYMENT_COMPLETED",
    // P6.2 — wallet connection session (Page4).
    WALLET_CONNECTION_SESSION_UPDATED: "WALLET_CONNECTION_SESSION_UPDATED",
    PAYMENT_CONNECTION_READY: "PAYMENT_CONNECTION_READY",
    // P6.3 — authoritative Payment Session (Page4 payment lifecycle).
    PAYMENT_SESSION_CREATED: "PAYMENT_SESSION_CREATED",
    PAYMENT_SESSION_UPDATED: "PAYMENT_SESSION_UPDATED",
    PAYMENT_REQUEST: "PAYMENT_REQUEST",
    PAYMENT_SESSION_COMPLETED: "PAYMENT_SESSION_COMPLETED",
    PAYMENT_SESSION_FAILED: "PAYMENT_SESSION_FAILED",
    // P6.4 — Game Smart Contract (identifier + state only).
    GAME_CONTRACT_UPDATED: "GAME_CONTRACT_UPDATED",
    // P6.5 — deployment results for clients.
    GAME_CONTRACT_DEPLOYED: "GAME_CONTRACT_DEPLOYED",
    GAME_CONTRACT_DEPLOY_FAILED: "GAME_CONTRACT_DEPLOY_FAILED",
    // P6.7 — authoritative start gate before OPEN_PAGE5.
    GAME_START_AUTHORIZED: "GAME_START_AUTHORIZED",
    GAME_INITIALIZING: "GAME_INITIALIZING",
    // R1.3D — sole authoritative signal for clients to open Page5.
    OPEN_PAGE5: "OPEN_PAGE5",
    // P5.3 — authoritative signal for clients to open Page6 after RESULT.
    OPEN_PAGE6: "OPEN_PAGE6",
    // P6.8B — contract settlement lifecycle (clients mirror only).
    SETTLEMENT_STARTED: "SETTLEMENT_STARTED",
    SETTLEMENT_SUBMITTED: "SETTLEMENT_SUBMITTED",
    SETTLEMENT_CONFIRMED: "SETTLEMENT_CONFIRMED",
    SETTLEMENT_COMPLETED: "SETTLEMENT_COMPLETED",
    SETTLEMENT_FAILED: "SETTLEMENT_FAILED",
    // R6.5 — completed result session closed (FINISH or timeout).
    SESSION_FINISHED: "SESSION_FINISHED",
    WALLET_REJECTED: "WALLET_REJECTED"
});

export const LOBBY_ERROR_CODES = Object.freeze({
    ROOM_NOT_FOUND: "ROOM_NOT_FOUND",
    ROOM_FULL: "ROOM_FULL",
    ROOM_LOCKED: "ROOM_LOCKED",
    INVALID_ROOM_ID: "INVALID_ROOM_ID",
    PLAYER_ALREADY_CONNECTED: "PLAYER_ALREADY_CONNECTED",
    ROOM_CREATION_LIMIT: "ROOM_CREATION_LIMIT",
    SERVER_DRAINING: "SERVER_DRAINING",
    INVALID_SECRET_MATRIX: "INVALID_SECRET_MATRIX",
    SECRET_MATRIX_MISMATCH: "SECRET_MATRIX_MISMATCH",
    INVALID_WALLET: "INVALID_WALLET",
    UNKNOWN_ERROR: "UNKNOWN_ERROR"
});

export const LOBBY_ERROR_MESSAGES = Object.freeze({
    [LOBBY_ERROR_CODES.ROOM_NOT_FOUND]:
        "Room not found. Check the Room ID and try again.",
    [LOBBY_ERROR_CODES.ROOM_FULL]:
        "This room is full.",
    [LOBBY_ERROR_CODES.ROOM_LOCKED]:
        "This room is no longer accepting players.",
    [LOBBY_ERROR_CODES.INVALID_ROOM_ID]:
        "Enter a valid Room ID.",
    [LOBBY_ERROR_CODES.PLAYER_ALREADY_CONNECTED]:
        "You are already connected to a room.",
    [LOBBY_ERROR_CODES.ROOM_CREATION_LIMIT]:
        "The server is not accepting new rooms right now. Please try again later.",
    [LOBBY_ERROR_CODES.SERVER_DRAINING]:
        "The server is shutting down and is not accepting new rooms.",
    [LOBBY_ERROR_CODES.INVALID_SECRET_MATRIX]:
        "Enter a complete Secret Matrix using A–Z and 0–9 only.",
    [LOBBY_ERROR_CODES.SECRET_MATRIX_MISMATCH]:
        "Secret Matrix codes do not match. Try again.",
    [LOBBY_ERROR_CODES.INVALID_WALLET]:
        "Invalid TON wallet address.",
    [LOBBY_ERROR_CODES.UNKNOWN_ERROR]:
        "Something went wrong. Please try again."
});
