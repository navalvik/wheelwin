/**
 * Socket event names for future stages.
 * No handlers are registered in Stage S1.
 */
export const SOCKET_EVENTS = Object.freeze({
    CONNECTION: "connection",
    DISCONNECT: "disconnect"
});

export const LOBBY_CLIENT_EVENTS = Object.freeze({
    CREATE_ROOM: "createRoom",
    JOIN_ROOM: "joinRoom",
    LEAVE_ROOM: "leaveRoom"
});

export const LOBBY_SERVER_EVENTS = Object.freeze({
    ROOM_CREATED: "roomCreated",
    ROOM_STATE: "roomState",
    ROOM_JOINED: "roomJoined",
    ROOM_LEFT: "roomLeft",
    ROOM_ERROR: "roomError",
    ROOM_CLOSED: "roomClosed",
    START_GAME: "startGame"
});

export const GAME_MESSAGE_CHANNEL = "game:message";
