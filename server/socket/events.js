/**
 * Socket event names.
 * Prefer lobbyProtocol.js for lobby names; this module re-exports them so
 * SocketGateway and older imports stay in sync.
 */
export const SOCKET_EVENTS = Object.freeze({
    CONNECTION: "connection",
    DISCONNECT: "disconnect"
});

export {
    LOBBY_CLIENT_EVENTS,
    LOBBY_SERVER_EVENTS
} from "./lobbyProtocol.js";

export const GAME_MESSAGE_CHANNEL = "game:message";
