import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { buildRoomWalletTransferUri } from "../payment/buildRoomWalletTransferUri.js";
import { useTonConnectUI, useTonWallet } from "@tonconnect/ui-react";
import { buildRoomWalletTonConnectRequest, payerMatchesConnectedWallet } from "../payment/buildRoomWalletTonConnectRequest.js";

import GameLayout from "../layouts/GameLayout";
import { usePlayerIdentity } from "../context/PlayerIdentityContext";
import { useAuthoritativeSession } from "../context/AuthoritativeSessionContext";
import {
    listAuthoritativePlayers,
    mapAuthoritativePlayerToInfoProp,
    resolveLocalPlayerId
} from "../game/session";
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
    const authoritative = useAuthoritativeSession();
    const [payment, setPayment] = useState({status: "PAYMENT_UNAVAILABLE", paymentAcceptanceEnabled: false});
    const [tonConnectUI] = useTonConnectUI();
    const connectedWallet = useTonWallet();
    const [sending, setSending] = useState(false);
    const [sentToWallet, setSentToWallet] = useState(false);
    const [paymentError, setPaymentError] = useState(null);
    const status = payment.status;
    const [transferQr, setTransferQr] = useState(null);
    const [showTransferQr, setShowTransferQr] = useState(false);

    useEffect(() => {
        let disposed = false;
        setTransferQr(null);
        let uri;
        try {
            uri = buildRoomWalletTransferUri(payment);
        } catch {
            return undefined;
        }
        QRCode.toDataURL(uri, { width: 320, margin: 4, errorCorrectionLevel: 'M' })
            .then((image) => {
                if (!disposed && Date.now() < payment.expiresAt) {
                    setTransferQr({ image, uri, reference: payment.paymentReference });
                }
            })
            .catch(() => { if (!disposed) setPaymentError('Could not generate payment QR.'); });
        const expiry = setTimeout(() => setTransferQr(null), Math.max(0, payment.expiresAt - Date.now()));
        return () => { disposed = true; clearTimeout(expiry); };
    }, [payment.paymentReference, payment.status, payment.paymentAcceptanceEnabled,
        payment.destinationWalletAddress, payment.payerAddress, payment.amountAtomic,
        payment.expiresAt, payment.network, payment.asset]);

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
            setSentToWallet(Boolean(payload.paymentReference && localStorage.getItem('wheelwin:payment:' + payload.paymentReference)));
        }

        const requestStatus = () => socket.emit(PAYMENT_STATUS_REQUEST, {roomId, playerId});
        socket.on('connect', requestStatus);
        socket.on(PAYMENT_STATUS_EVENT, handlePaymentStatus);

        // Re-request the authoritative payment state so a status event that
        // was emitted before this page subscribed is re-delivered now.
        if (requestedRef.current !== roomId + ":" + playerId) {
            requestedRef.current = roomId + ":" + playerId;
            socket.emit(PAYMENT_STATUS_REQUEST, { roomId, playerId });
        }

        return () => {
            socket.off('connect', requestStatus);
            socket.off(PAYMENT_STATUS_EVENT, handlePaymentStatus);
        };
    }, [roomId, playerId]);

    // Only an active Page4 with an unsettled payment requests observation.
    // Room-level server throttling coalesces the three players; the 64-wallet
    // catalog is never scanned. Stop immediately on settlement/unmount/expiry.
    useEffect(() => {
        if (!roomId || !playerId
            || payment.paymentAcceptanceEnabled !== true
            || !["AWAITING_PAYMENT", "MATCHED", "AWAITING_CONFIRMATION"].includes(payment.status)
            || !Number.isSafeInteger(payment.expiresAt)) return undefined;

        const check = () => {
            if (socket.connected && Date.now() < payment.expiresAt) {
                socket.emit(PAYMENT_STATUS_REQUEST, { roomId, playerId });
            }
        };
        const id = setInterval(check, 4000);
        return () => clearInterval(id);
    }, [roomId, playerId, payment.paymentAcceptanceEnabled,
        payment.status, payment.expiresAt]);

    const walletMatches = payerMatchesConnectedWallet(payment.payerAddress, connectedWallet, payment.network);
    const payable = payment.paymentAcceptanceEnabled === true
        && status === "AWAITING_PAYMENT";

    const localPlayerId = resolveLocalPlayerId(
        playerId ?? null,
        authoritative.players,
        { verifyCompleted: true }
    );
    const players = listAuthoritativePlayers(authoritative.players)
        .map((player, index) => mapAuthoritativePlayerToInfoProp(
            player,
            index,
            { localPlayerId }
        ));
    const localPlayer = players.find((player) => player.isLocal);
    const amount = Number.isSafeInteger(payment.amountAtomic)
        ? (payment.amountAtomic / 1_000_000_000).toFixed(2)
        : null;
    // The room ledger keeps TON as its protocol asset identifier; Gram is the
    // wallet-facing denomination shown in the Testnet wallet confirmation.
    const assetLabel = payment.asset === "TON" ? "GRAM" : payment.asset || "GRAM";

    async function initiatePayment() {
        if (!payable || sending || sentToWallet || !walletMatches) return;
        setPaymentError(null);
        const attemptKey = 'wheelwin:payment:' + payment.paymentReference;
        if (localStorage.getItem(attemptKey)) { setSentToWallet(true); return; }
        // Validate before claiming submission: an expired/invalid request must
        // not leave a permanent uncertain-payment lock in this browser.
        let transaction;
        try { transaction = buildRoomWalletTonConnectRequest(payment); }
        catch (error) { setPaymentError(error.message); return; }
        localStorage.setItem(attemptKey, 'SUBMISSION_UNKNOWN');
        setSentToWallet(true);
        setSending(true);
        try {
            await tonConnectUI.sendTransaction(transaction);
            // TonConnect acknowledgement is NOT a blockchain confirmation.
            // Prevent repeat submits; only the server can mark the seat SETTLED.
            setSentToWallet(true);
            socket.emit(PAYMENT_STATUS_REQUEST, {roomId, playerId});
        } catch (error) {
            if (error?.name === 'UserRejectsError') {
                localStorage.removeItem(attemptKey);
                setSentToWallet(false);
            }
            setPaymentError(error?.message ?? "Wallet rejected payment");
        } finally {
            setSending(false);
        }
    }

    function handleWalletConfirmation() {
        if (!connectedWallet || !walletMatches) {
            tonConnectUI.openModal();
            return;
        }

        initiatePayment();
    }

    return (
        <GameLayout message="PAYMENT" showNextButton={false}>
            <section className="page4Payment" aria-live="polite">
                <div className="page4Payment__panel">
                    <div className="page4Payment__identity">
                        YOUR NICKNAME: {localPlayer?.nickname ?? "—"} · TESTNET
                    </div>

                    <div className="page4Payment__players">
                        {players.map((player) => (
                            <article
                                className={`page4Payment__player${player.isLocal ? " page4Payment__player--local" : ""}`}
                                key={player.key}
                            >
                                <div className="page4Payment__playerTitle">
                                    {player.isLocal ? "YOU" : "PLAYER"}
                                </div>
                                <strong className="page4Payment__nickname">{player.nickname}</strong>
                                <span className="page4Payment__icon" aria-hidden="true">{player.icon}</span>
                                <div className="page4Payment__detail">
                                    <span>WALLET</span>
                                    <strong>Wallet registered</strong>
                                </div>
                                <div className="page4Payment__detail">
                                    <span>STATUS</span>
                                    <strong>{status === "SETTLED" && player.isLocal
                                        ? "Payment verified"
                                        : "Waiting for payments"}</strong>
                                </div>
                            </article>
                        ))}
                    </div>

                    {payment.paymentAcceptanceEnabled ? (
                        <>
                            <div className="page4Payment__summary">
                                PAY (AMOUNT) {assetLabel}: {amount ?? "—"} {assetLabel}
                                {payment.destinationWalletAddress
                                    ? ` - ${payment.destinationWalletAddress}`
                                    : ""}
                            </div>
                            <p className="page4Payment__waiting">
                                {status === "SETTLED"
                                    ? "PAYMENT RECEIVED — WAITING FOR OTHER PLAYERS"
                                    : "WAITING FOR PAYMENTS"}
                            </p>
                            {payable && (
                                <>
                                    <details>
                                    <summary>Alternative payment link</summary>
                                    <p>Open this link with the wallet's general QR scanner. The scanner inside the recipient address field does not fill the amount or comment.</p>
                                    <button className="page4Payment__confirm" type="button"
                                        disabled={!transferQr || transferQr.reference !== payment.paymentReference}
                                        onClick={() => { tonConnectUI.closeModal(); setShowTransferQr((value) => !value); }}>
                                        {showTransferQr ? 'HIDE PAYMENT QR' : `PAY ${amount} GRAM — SHOW PAYMENT QR`}
                                    </button>
                                    {showTransferQr && transferQr && transferQr.reference === payment.paymentReference && (
                                        <div className="page4Payment__transferQr">
                                            <img src={transferQr.image} alt={`Payment QR for ${amount} GRAM`} />
                                            <p>{amount} GRAM · TESTNET</p>
                                            <p>Comment: WW1:{payment.paymentReference}</p>
                                            <a href={transferQr.uri}>OPEN PAYMENT IN WALLET</a>
                                            <p>Scan in Gram Wallet. Confirm only once; the server checks the transfer.</p>
                                        </div>
                                    )}
                                    </details>
                                    {!connectedWallet && (
                                        <p className="page4Payment__connectHint">
                                            Connect Gram Wallet using its general QR scanner or Connected Apps scanner. Then return here to confirm the payment. The scanner inside Send → recipient address cannot connect the game.
                                        </p>
                                    )}
                                <button
                                    className="page4Payment__confirm"
                                    type="button"
                                    disabled={sending || sentToWallet}
                                    onClick={handleWalletConfirmation}
                                >
                                    {sending
                                        ? "OPENING WALLET…"
                                        : sentToWallet
                                            ? "PAYMENT SENT — WAITING FOR CONFIRMATION"
                                            : !connectedWallet
                                                ? "CONNECT GRAM WALLET"
                                                : !walletMatches
                                                    ? "SELECT TESTNET WALLET"
                                                    : "CONFIRM PAYMENT IN GRAM WALLET"}
                                </button>
                                </>
                            )}
                            {connectedWallet && !walletMatches && payable && (
                                <p className="page4Payment__error" role="alert">
                                    Select the Testnet wallet entered on Page3 before confirming.
                                </p>
                            )}
                            {paymentError && (
                                <p className="page4Payment__error" role="alert">{paymentError}</p>
                            )}
                        </>
                    ) : (
                        <p className="page4Payment__waiting">
                            Payments are unavailable. Do not send GRAM to any room wallet.
                        </p>
                    )}
                </div>
            </section>
        </GameLayout>
    );
}
