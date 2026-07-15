export const LOBBY_CLIENT_EVENTS = Object.freeze({
    CREATE_ROOM: "createRoom",
    JOIN_ROOM: "joinRoom",
    LEAVE_ROOM: "leaveRoom",
    DISCONNECT: "disconnect"
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
    SETUP_SESSION_EXPIRED: "SETUP_SESSION_EXPIRED"
});

export const LOBBY_ERROR_CODES = Object.freeze({
    ROOM_NOT_FOUND: "ROOM_NOT_FOUND",
    ROOM_FULL: "ROOM_FULL",
    ROOM_LOCKED: "ROOM_LOCKED",
    INVALID_ROOM_ID: "INVALID_ROOM_ID",
    PLAYER_ALREADY_CONNECTED: "PLAYER_ALREADY_CONNECTED",
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
    [LOBBY_ERROR_CODES.UNKNOWN_ERROR]:
        "Something went wrong. Please try again."
});
