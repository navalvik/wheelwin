import { OUTGOING_SOCKET_EVENTS } from "../socket/socketEvents";

/**
 * Ask the authoritative server for this player's Page4 state on every
 * successful Socket.IO connection, including reconnect after an outage.
 *
 * Never trust or derive payment status from a local wallet or socket event.
 * In particular, do not queue a request while disconnected: the connect
 * handler sends exactly one fresh request when the connection returns.
 */
export function bindPage4PaymentStatusRecovery(socket, { roomId, playerId }) {
    if (!roomId || !playerId) {
        return () => {};
    }

    const request = () => {
        if (socket.connected === true) {
            socket.emit(OUTGOING_SOCKET_EVENTS.PAYMENT_STATUS_REQUEST, {
                roomId,
                playerId
            });
        }
    };

    socket.on("connect", request);
    request();

    return () => {
        socket.off("connect", request);
    };
}
