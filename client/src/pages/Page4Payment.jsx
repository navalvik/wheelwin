import { useEffect, useState } from "react";

import GameLayout from "../layouts/GameLayout";
import { usePlayerIdentity } from "../context/PlayerIdentityContext";
import socket from "../socket/socket";
import {
    INCOMING_SOCKET_EVENTS
} from "../socket/socketEvents";

import { bindPage4PaymentStatusRecovery } from "./page4PaymentStatusRecovery";

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

export default function Page4Payment() {
    const { identity } = usePlayerIdentity();
    const { roomId, playerId } = identity ?? {};
    const [status, setStatus] = useState("PAYMENT_UNAVAILABLE");

    useEffect(() => {
        if (!roomId || !playerId) {

            return;
        }

        function handlePaymentStatus(payload) {
            if (payload?.roomId !== roomId
                || payload?.playerId !== playerId
                || typeof payload.status !== "string") {
                return;
            }
            setStatus(payload.status);
        }

        setStatus("PAYMENT_UNAVAILABLE");
        socket.on(PAYMENT_STATUS_EVENT, handlePaymentStatus);
        const unbindRecovery = bindPage4PaymentStatusRecovery(socket, { roomId, playerId });

        return () => {
            unbindRecovery();
            socket.off(PAYMENT_STATUS_EVENT, handlePaymentStatus);
        };
    }, [roomId, playerId]);

    return (
        <GameLayout message="ENTRY PAYMENT" showNextButton={false}>
            <section className="page4Payment" aria-live="polite">
                <h2>Payment status: {status}</h2>
                <p>
                    Payment acceptance is disabled while aborted-game refunds are unavailable.
                    No wallet request or destination has been issued.
                </p>
            </section>
        </GameLayout>
    );
}