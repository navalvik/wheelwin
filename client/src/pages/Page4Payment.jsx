import { useEffect, useState } from "react";

import GameLayout from "../layouts/GameLayout";
import { usePlayerIdentity } from "../context/PlayerIdentityContext";
import socket from "../socket/socket";
import {
    INCOMING_SOCKET_EVENTS,
    OUTGOING_SOCKET_EVENTS
} from "../socket/socketEvents";

import "../styles/page4payment.css";

/**
 * P6.7 — Authoritative Page4 payment-state recovery.
 *
 * Page4 does NOT infer payment state from socket connection status or from
 * any client assertion. It only renders what the server pushes through
 * ENTRY_PAYMENT_SESSION_UPDATED, and it re-requests that authoritative state
 * after it mounts so it never stays stale when the original event was emitted
 * while the page was not yet subscribed (e.g. a reconnect that landed the
 * player on Page4 after the payment status was already delivered).
 *
 * Payloads are filtered by room and player identity; listeners are cleaned up
 * on unmount and whenever the identity changes.
 */
const PAYMENT_STATUS_EVENT = INCOMING_SOCKET_EVENTS.ENTRY_PAYMENT_SESSION_UPDATED;
const PAYMENT_STATUS_REQUEST = OUTGOING_SOCKET_EVENTS.PAYMENT_STATUS_REQUEST;

export default function Page4Payment() {
    const { identity } = usePlayerIdentity();
    const { roomId, playerId } = identity ?? {};
    const [status, setStatus] = useState("PAYMENT_UNAVAILABLE");
    const [connected, setConnected] = useState(socket.connected);

    useEffect(() => {
        // An old room's status must never be shown for a new room or player.
        setStatus("PAYMENT_UNAVAILABLE");
        setConnected(socket.connected);

        function handlePaymentStatus(payload) {
            if (payload?.roomId !== roomId
                || payload?.playerId !== playerId
                || typeof payload.status !== "string") {
                return;
            }
            setStatus(payload.status);
        }

        function requestCurrentStatus() {
            setConnected(socket.connected);
            if (socket.connected && roomId && playerId) {
                socket.emit(PAYMENT_STATUS_REQUEST, { roomId, playerId });
            }
        }

        // A new identity, a remount, and every reconnect each need a fresh
        // authoritative status. The request does not authorize any transfer.
        socket.on(PAYMENT_STATUS_EVENT, handlePaymentStatus);
        socket.on("connect", requestCurrentStatus);
        socket.on("disconnect", requestCurrentStatus);
        requestCurrentStatus();

        return () => {
            socket.off(PAYMENT_STATUS_EVENT, handlePaymentStatus);
            socket.off("connect", requestCurrentStatus);
            socket.off("disconnect", requestCurrentStatus);
        };
    }, [roomId, playerId]);

    return (
        <GameLayout message="ENTRY PAYMENT" showNextButton={false}>
            <section className="page4Payment" aria-live="polite">
                <h2>Payment status: {status}</h2>
                <p role="status">Server connection: {connected ? "CONNECTED" : "DISCONNECTED"}</p>
                {!roomId || !playerId ? (
                    <p role="alert">Waiting for server-authorized room identity. No payment can be sent.</p>
                ) : null}
                <p>
                    Payment acceptance is disabled while aborted-game refunds are unavailable.
                    No wallet request or destination has been issued.
                </p>
            </section>
        </GameLayout>
    );
}