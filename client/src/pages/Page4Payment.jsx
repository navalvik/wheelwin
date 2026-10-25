import { useEffect, useRef, useState } from "react";

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
    const [payment, setPayment] = useState({status: "PAYMENT_UNAVAILABLE", paymentAcceptanceEnabled: false});
    const status = payment.status;

    // Only request the authoritative payment state once per identity cycle.
    // Resetting the flag when the identity changes lets a later identity
    // readiness (identity becomes ready after the component initially mounts)
    // re-issue the request without creating a request/response loop.
    const requestedRef = useRef(null);

    useEffect(() => {
        if (!roomId || !playerId) {

            requestedRef.current = null;
            return;
        }

        function handlePaymentStatus(payload) {
            if (payload?.roomId !== roomId
                || payload?.playerId !== playerId
                || typeof payload.status !== "string") {
                return;
            }
            setPayment(payload);
        }

        socket.on(PAYMENT_STATUS_EVENT, handlePaymentStatus);

        // Re-request the authoritative payment state so a status event that
        // was emitted before this page subscribed is re-delivered now.
        if (requestedRef.current !== roomId + ":" + playerId) {
            requestedRef.current = roomId + ":" + playerId;
            socket.emit(PAYMENT_STATUS_REQUEST, { roomId, playerId });
        }

        return () => {
            socket.off(PAYMENT_STATUS_EVENT, handlePaymentStatus);
        };
    }, [roomId, playerId]);

    return (
        <GameLayout message="ENTRY PAYMENT" showNextButton={false}>
            <section className="page4Payment" aria-live="polite">
                <h2>Payment status: {status}</h2>
                {!payment.paymentAcceptanceEnabled ? (
                    <p>Payments are temporarily disabled. Do not send GRAM to any room wallet.</p>
                ) : (
                    <>
                        <p>Payment information is issued and verified by the game server.</p>
                        {payment.destinationWalletAddress && (
                            <p>Room wallet: <code>{payment.destinationWalletAddress}</code></p>
                        )}
                        {Number.isSafeInteger(payment.amountAtomic) && (
                            <p>Required: {(payment.amountAtomic / 1_000_000_000).toFixed(2)} GRAM</p>
                        )}
                        {payment.paymentReference && (
                            <p>Transfer comment: <code>WW1:{payment.paymentReference}</code></p>
                        )}
                        {status === "AWAITING_PAYMENT" && (
                            <button
                                type="button"
                                onClick={() => socket.emit(PAYMENT_STATUS_REQUEST, {roomId, playerId})}
                            >
                                CHECK PAYMENT
                            </button>
                        )}
                        {status === "SETTLED" && (
                            <p>Payment verified. Waiting for the other players.</p>
                        )}
                    </>
                )}
            </section>
        </GameLayout>
    );
}