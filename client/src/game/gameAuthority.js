import socket from "../socket/socket";

/**
 * When the socket is connected, multiplayer state (game flow, winner)
 * must come from the server — not from local simulation.
 */
export function isServerAuthoritative() {

    return socket.connected;

}
