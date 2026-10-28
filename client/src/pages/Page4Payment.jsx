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
import { submitNativeGramToConnectedWallet } from "../payment/nativeGramWalletSubmission.js";
import { getTonConnectUI } from "../payment/tonConnectUIAdapter.js";

import "../styles/page4payment.css";

/**
 * Page4 displays server-authoritative payment state only.
 * The payment action stays unavailable until the server exposes a verified
 * room-wallet payment request. Never synthesize a destination or amount here.
 */
const PAYMENT_STATUS_EVENT = INCOMING_SOCKET_EVENTS.ENTRY_PAYMENT_SESSION_UPDATED;
const PAYMENT_STATUS_REQUEST = OUTGOING_SOCKET_EVENTS.PAYMENT_STATUS_REQUEST;
const INITIAL_PAYMENT_REQUEST = INCOMING_SOCKET_EVENTS.PAYMENT_REQUEST;

export default function Page4Payment() {
    const { identity } = usePlayerIdentity();
    const { roomId, playerId } = identity ?? {};
    const [submitting, setSubmitting] = useState(false);
    const [walletError, setWalletError] = useState(null);
    const [submittedPaymentKey, setSubmittedPaymentKey] = useState(null);
    const [walletAdapter, setWalletAdapter] = useState(null);
    const [walletRevision, setWalletRevision] = useState(0);
    const [state, setState] = useState({
        roomId: null,
        playerId: null,
        status: "WAITING_FOR_SESSION",
        connected: socket.connected,
        payment: null,
        reason: null
    });

    useEffect(() => {
        // Singleton survives Page4 remount and recovery; only this listener
        // belongs to the component. Connecting never sends funds.
        let ui;
        try {
            ui = getTonConnectUI();
        } catch {
            setWalletError("TON Connect could not initialize. Payment cannot be submitted.");
            return undefined;
        }
        if (!ui || typeof ui.onStatusChange !== "function") {
            setWalletError("TON Connect is unavailable. Payment cannot be submitted.");
            return undefined;
        }
        let unsubscribe;
        try {
            unsubscribe = ui.onStatusChange(() => {
                setWalletRevision(value => value + 1);
            });
            setWalletAdapter(ui);
            setWalletError(null);
        } catch {
            // A connector bootstrap failure must not crash Page4.
            setWalletError("TON Connect could not initialize. Payment cannot be submitted.");
            return undefined;
        }
        return () => {
            unsubscribe?.();
        };
    }, []);

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
                reason: payload.reason ?? null,
                connected: socket.connected,
                payment: {
                    amountAtomic: payload.amountAtomic,
                    asset: payload.asset,
                    network: payload.network,
                    destination: payload.destinationWalletAddress,
                    reference: payload.paymentReference,
                    enabled: payload.paymentAcceptanceEnabled === true,
                    expectedSender: payload.expectedSenderWalletAddress,
                    expiresAt: payload.expiresAt,
                    legacyJettonFieldsPresent: payload.jettonMaster != null ||
                        payload.senderJettonWalletAddress != null ||
                        payload.jettonWalletVerified != null
                }
            });
        };

        // Initial request is a notification only. Always re-read the current
        // authoritative intent through the bound socket, never pay from a
        // possibly stale event that arrived while Page4 was mounting.
        const handleInitialPaymentRequest = (payload) => {
            if (payload?.roomId === roomId && payload?.playerId === playerId) {
                requestStatus();
            }
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
            reason: null,
            connected: socket.connected,
            payment: null
        });

        socket.on(PAYMENT_STATUS_EVENT, handlePaymentStatus);
        socket.on(INITIAL_PAYMENT_REQUEST, handleInitialPaymentRequest);
        socket.on("connect", handleConnect);
        socket.on("disconnect", handleDisconnect);
        requestStatus();

        return () => {
            active = false;
            socket.off(PAYMENT_STATUS_EVENT, handlePaymentStatus);
            socket.off(INITIAL_PAYMENT_REQUEST, handleInitialPaymentRequest);
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

    // Register only the connected Testnet payer address for this server-owned
    // socket seat. The server derives stake and reference from Page2 identity;
    // the transfer is still independently verified on-chain.
    useEffect(() => {
        const account = walletAdapter?.account;
        if (!roomId || !playerId || !connected || !socket.connected
            || account?.chain !== "-3"
            || !tonAccountIdentityOrNull(account.address)) {
            return;
        }
        socket.emit(OUTGOING_SOCKET_EVENTS.PAYMENT_WALLET_REGISTER, {
            address: account.address,
            chain: "-3"
        });
    }, [roomId, playerId, connected, walletAdapter, walletRevision]);

    const payment = matchesIdentity ? state.payment : null;

    // Once the server has explicitly enabled this room's payment session,
    // refresh authoritative status at a bounded rate while Page4 is mounted.
    // The server coalesces three players into one observation per room. No
    // client payment or confirmation is inferred from this timer.
    const shouldRefreshPayment = connected && payment?.enabled === true;
    useEffect(() => {
        if (!roomId || !playerId || !shouldRefreshPayment) return undefined;
        const interval = window.setInterval(() => {
            if (socket.connected) {
                socket.emit(PAYMENT_STATUS_REQUEST, { roomId, playerId });
            }
        }, 10_000);
        return () => window.clearInterval(interval);
    }, [roomId, playerId, shouldRefreshPayment]);

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
        && Boolean(tonAccountIdentityOrNull(payment.expectedSender))
        && tonAccountIdentityOrNull(payment.destination) !== tonAccountIdentityOrNull(payment.expectedSender)
        && payment.legacyJettonFieldsPresent !== true
        && typeof payment.reference === "string"
        && payment.reference.trim() !== ""
        && typeof atomicAmount === "string"
        && /^[1-9][0-9]*$/.test(atomicAmount);
    // TonConnectUI is an explicitly initialized wallet adapter supplied by
    // application bootstrap. Never create an implicit wallet connection here.
    // Subscription forces a fresh account check after TON Connect changes.
    void walletRevision;
    const walletReady = Boolean(walletAdapter?.account?.chain === "-3" &&
        tonAccountIdentityOrNull(walletAdapter?.account?.address) ===
            tonAccountIdentityOrNull(payment?.expectedSender) &&
        typeof walletAdapter?.sendTransaction === "function");
    const paymentKey = `${roomId ?? ""}:${playerId ?? ""}:${payment?.reference ?? ""}`;
    const alreadySubmitted = submittedPaymentKey === paymentKey;
    const canPay = requestReady && status === "AWAITING_PAYMENT" &&
        !alreadySubmitted &&
        walletReady && !submitting && Number.isSafeInteger(payment?.expiresAt) &&
        payment.expiresAt > Date.now();
    const submitPayment = async () => {
        if (!canPay) return;
        setSubmitting(true);
        setWalletError(null);
        try {
            await submitNativeGramToConnectedWallet({
                payment, walletAdapter,
                onSubmitted: () => socket.emit(PAYMENT_STATUS_REQUEST, { roomId, playerId })
            });
            // SDK resolution is not chain confirmation. Suppress accidental
            // second sends for the same intent while the server reconciles.
            setSubmittedPaymentKey(paymentKey);
        } catch {
            // Do not expose connector errors that may contain account metadata.
            setWalletError("Wallet did not submit the payment. Check your wallet and try again.");
        } finally {
            setSubmitting(false);
        }
    };
    const displayAmount = requestReady
        ? formatGramUnits(atomicAmount)
        : null;

    return (
        <GameLayout message="ENTRY PAYMENT" showNextButton={false}>
            <section className="page4Payment" aria-live="polite">
                <h2>Payment status: {status}</h2>
                <button type="button" disabled={!walletAdapter} onClick={() => walletAdapter?.openModal?.()}>
                    {walletAdapter?.connected ? "Connected TON wallet" : "CONNECT TON WALLET"}
                </button>
                {walletError && <p role="alert">{walletError}</p>}
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
                        <button type="button" disabled={!canPay} onClick={submitPayment}>
                            {submitting ? "Waiting for wallet approval…" : alreadySubmitted ? "Waiting for server confirmation" : "CONFIRM IN TELEGRAM WALLET"}
                        </button>
                        {status === "CONFIRMING_PAYMENT" && (
                            <p>Payment detected. Waiting for independent blockchain confirmation. Do not pay again.</p>
                        )}
                        {!walletReady && status === "AWAITING_PAYMENT" && <p>Connect the matching TON Testnet wallet to enable payment.</p>}
                    </div>
                )}
                {identityReady && connected && status === "PAYMENT_UNAVAILABLE" && (
                    <p role="alert">The server has disabled payments for this room. Do not send GRAM. {state.reason ? `Reason: ${state.reason}` : ""}</p>
                )}
                {identityReady && connected && !requestReady && status !== "PAYMENT_UNAVAILABLE" && (
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
