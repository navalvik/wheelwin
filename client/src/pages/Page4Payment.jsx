import { useEffect, useState } from "react";

import GameLayout from "../layouts/GameLayout";
import { usePlayerIdentity } from "../context/PlayerIdentityContext";
import socket from "../socket/socket";
import {
    INCOMING_SOCKET_EVENTS,
    OUTGOING_SOCKET_EVENTS
} from "../socket/socketEvents";

import { formatGramUnits } from "../payment/gramAmount.js";
import { tonAccountIdentityOrNull } from "../payment/gramPaymentAuthorization.js";

import "../styles/page4payment.css";

/**
 * Page4 displays server-authoritative payment state only.
 * The payment action stays unavailable until the server exposes a verified
 * room-wallet payment request. Never synthesize a destination or amount here.
 */
const PAYMENT_STATUS_EVENT = INCOMING_SOCKET_EVENTS.ENTRY_PAYMENT_SESSION_UPDATED;
const PAYMENT_STATUS_REQUEST = OUTGOING_SOCKET_EVENTS.PAYMENT_STATUS_REQUEST;

export default function Page4Payment() {
    const { identity } = usePlayerIdentity();
    const { roomId, playerId } = identity ?? {};
    const [state, setState] = useState({
        roomId: null,
        playerId: null,
        status: "WAITING_FOR_SESSION",
        connected: socket.connected,
        payment: null
    });

    useEffect(() => {
        if (!roomId || !playerId) {
            return undefined;
        }

        let active = true;

        const requestStatus = () => {
            if (!active || !socket.connected) return;
            socket.emit(PAYMENT_STATUS_REQUEST, { roomId, playerId });
        };

        const handlePaymentStatus = (payload) => {
            if (!active
                || payload?.roomId !== roomId
                || payload?.playerId !== playerId
                || typeof payload.status !== "string") {
                return;
            }
            setState({
                roomId,
                playerId,
                status: payload.status,
                connected: socket.connected,
                payment: {
                    amountAtomic: payload.amountAtomic,
                    asset: payload.asset,
                    network: payload.network,
                    destination: payload.destinationWalletAddress,
                    reference: payload.paymentReference,
                    enabled: payload.paymentAcceptanceEnabled === true,
                    expectedSender: payload.expectedSenderWalletAddress,
                    legacyJettonFieldsPresent: payload.jettonMaster != null ||
                        payload.senderJettonWalletAddress != null ||
                        payload.jettonWalletVerified != null
                }
            });
        };

        const handleConnect = () => {
            if (!active) return;
            setState((current) => ({ ...current, connected: true }));
            requestStatus();
        };

        const handleDisconnect = () => {
            if (!active) return;
            setState((current) => ({ ...current, connected: false }));
        };

        setState({
            roomId,
            playerId,
            status: "WAITING_FOR_SERVER",
            connected: socket.connected,
            payment: null
        });

        socket.on(PAYMENT_STATUS_EVENT, handlePaymentStatus);
        socket.on("connect", handleConnect);
        socket.on("disconnect", handleDisconnect);
        requestStatus();

        return () => {
            active = false;
            socket.off(PAYMENT_STATUS_EVENT, handlePaymentStatus);
            socket.off("connect", handleConnect);
            socket.off("disconnect", handleDisconnect);
        };
    }, [roomId, playerId]);

    const identityReady = Boolean(roomId && playerId);
    const matchesIdentity = state.roomId === roomId && state.playerId === playerId;
    const connected = identityReady && matchesIdentity ? state.connected : socket.connected;
    const status = !identityReady
        ? "WAITING_FOR_PLAYER_IDENTITY"
        : !connected
            ? "SERVER_DISCONNECTED"
            : matchesIdentity
                ? state.status
                : "WAITING_FOR_SERVER";

    const payment = matchesIdentity ? state.payment : null;
    // Never present a transfer destination unless the server explicitly enables
    // intake and all authoritative payment fields are present.
    // The current server payment-intent model uses safe integer atomic amounts;
    // a future bigint-safe protocol may send decimal strings instead.
    const atomicAmount = typeof payment?.amountAtomic === "string"
        ? payment.amountAtomic
        : Number.isSafeInteger(payment?.amountAtomic)
            ? String(payment.amountAtomic)
            : null;
    const requestReady = connected
        && payment?.enabled === true
        && payment.network === "testnet"
        // Server uses native TON asset identity. WheelWin displays it as GRAM.
        && payment.asset === "TON"
        && Boolean(tonAccountIdentityOrNull(payment.destination))
        && payment.legacyJettonFieldsPresent !== true
        && typeof payment.reference === "string"
        && payment.reference.trim() !== ""
        && typeof atomicAmount === "string"
        && /^[1-9][0-9]*$/.test(atomicAmount);
    const displayAmount = requestReady
        ? formatGramUnits(atomicAmount)
        : null;

    return (
        <GameLayout message="ENTRY PAYMENT" showNextButton={false}>
            <section className="page4Payment" aria-live="polite">
                <h2>Payment status: {status}</h2>
                {!identityReady && (
                    <p>Waiting for your room and player session to become available.</p>
                )}
                {identityReady && !connected && (
                    <p>Connection to the game server was lost. Your payment status will be refreshed automatically after reconnection.</p>
                )}
                {requestReady && (
                    <div className="page4Payment__request">
                        <p>Amount: {displayAmount} GRAM</p>
                        <p>Room wallet: {payment.destination}</p>
                        <p>Payment reference: {payment.reference}</p>
                    </div>
                )}
                {identityReady && connected && !requestReady && (
                    <p>
                        Waiting for the server-authoritative native GRAM room-wallet payment session.
                        Do not transfer funds until the verified destination, amount,
                        and payment request are displayed.
                    </p>
                )}
            </section>
        </GameLayout>
    );
}
