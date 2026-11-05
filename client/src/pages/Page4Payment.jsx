import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { buildRoomWalletTransferUri } from "../payment/buildRoomWalletTransferUri.js";
import { useTonConnectUI, useTonWallet } from "@tonconnect/ui-react";
import { buildRoomWalletTonConnectRequest, payerMatchesConnectedWallet } from "../payment/buildRoomWalletTonConnectRequest.js";
import {
    getMainnetPlayerPaymentStatus,
    mergeMainnetPaymentStatus,
    normalizeMainnetPaymentRequest,
    runMainnetPaymentAction
} from "../payment/mainnetPaymentRequest.js";
import {
    createPaymentStatusRequest,
    hasSubmissionAcknowledgement,
    PAYMENT_QR_DISPLAYED_STATE,
    PAYMENT_SUBMISSION_ACKNOWLEDGED_STATE,
    PAYMENT_SUBMISSION_PENDING_STATE,
    PAYMENT_SUBMISSION_UNKNOWN_STATE,
    submissionAttemptIsActive
} from "../payment/paymentStatusRequest.js";

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
const PAYMENT_REQUEST_EVENT = "PAYMENT_REQUEST";

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
    const paymentReferenceRef = useRef(null);
    const paymentAcceptanceRef = useRef(false);
    const mainnetRequestRef = useRef(null);
    const mainnetMode = payment.network === "mainnet";
    const networkLabel = mainnetMode ? "MAINNET"
        : payment.network === "testnet" ? "TESTNET" : "NETWORK";

    useEffect(() => {
        let disposed = false;
        if (mainnetMode || payment.paymentAcceptanceEnabled !== true) return undefined;
        let uri;
        try {
            uri = buildRoomWalletTransferUri({
                paymentAcceptanceEnabled: payment.paymentAcceptanceEnabled,
                status: payment.status,
                paymentReference: payment.paymentReference,
                destinationWalletAddress: payment.destinationWalletAddress,
                payerAddress: payment.payerAddress,
                amountAtomic: payment.amountAtomic,
                expiresAt: payment.expiresAt,
                network: payment.network,
                asset: payment.asset
            });
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
        payment.expiresAt, payment.network, payment.asset, mainnetMode]);

    useEffect(() => {
        if (!mainnetMode || !Number.isSafeInteger(payment.expiresAt)) return undefined;
        const timeout = setTimeout(() => {
            mainnetRequestRef.current = null;
            paymentReferenceRef.current = null;
            setPayment((current) => ({
                ...current,
                status: "PAYMENT_EXPIRED",
                paymentAcceptanceEnabled: false,
                paymentReference: null,
                payerAddress: null,
                destinationWalletAddress: null,
                amountAtomic: null
            }));
        }, Math.max(0, payment.expiresAt - Date.now()));
        return () => clearTimeout(timeout);
    }, [mainnetMode, payment.expiresAt]);

    // Only request the authoritative payment state once per identity cycle.
    // Resetting the flag when the identity changes lets a later identity
    // readiness (identity becomes ready after the component initially mounts)
    // re-issue the request without creating a request/response loop.
    const requestedRef = useRef(null);

    useEffect(() => {
        if (!roomId || !playerId) {

            requestedRef.current = null;
            paymentReferenceRef.current = null;
            mainnetRequestRef.current = null;
            return;
        }

        const identityKey = roomId + ":" + playerId;
        if (requestedRef.current !== identityKey) {
            const wasMainnet = mainnetRequestRef.current !== null;
            paymentReferenceRef.current = null;
            mainnetRequestRef.current = null;
            paymentAcceptanceRef.current = false;
            if (wasMainnet) {
                setPayment({ status: "PAYMENT_UNAVAILABLE", paymentAcceptanceEnabled: false });
                setSentToWallet(false);
            }
        }
        paymentReferenceRef.current = null;

        function handlePaymentStatus(payload) {
            if (payload?.roomId !== roomId
                || payload?.playerId !== playerId
                || typeof payload.status !== "string") {
                return;
            }
            if (payload.network !== "mainnet"
                || typeof payload.paymentAcceptanceEnabled === "boolean") {
                paymentAcceptanceRef.current = payload.paymentAcceptanceEnabled === true;
            }
            const isMainnetUpdate = payload.network === "mainnet"
                || mainnetRequestRef.current?.roomId === roomId;
            const nextPayment = isMainnetUpdate
                ? mergeMainnetPaymentStatus(mainnetRequestRef.current, payload, { roomId, playerId })
                : payload;
            if (isMainnetUpdate) {
                mainnetRequestRef.current = nextPayment.paymentAcceptanceEnabled === true
                    && nextPayment.paymentReference
                    && nextPayment.expiresAt > Date.now()
                    ? nextPayment
                    : null;
            }
            const nextPaymentReference = nextPayment.paymentReference ?? null;
            if (paymentReferenceRef.current !== nextPaymentReference) {
                setTransferQr(null);
                setShowTransferQr(false);
            }
            setPayment(nextPayment);
            paymentReferenceRef.current = nextPaymentReference;
            setSentToWallet(submissionAttemptIsActive(localStorage, nextPaymentReference));
        }

        function handlePaymentRequest(payload) {
            if (payload?.roomId !== roomId || payload?.playerId !== playerId) return;
            const request = normalizeMainnetPaymentRequest(payload, {
                roomId,
                playerId,
                paymentAcceptanceEnabled: paymentAcceptanceRef.current
            });
            if (!request) {
                setPayment((current) => ({
                    ...current,
                    network: "mainnet",
                    paymentAcceptanceEnabled: false,
                    status: "PAYMENT_UNAVAILABLE",
                    paymentReference: null,
                    payerAddress: null,
                    destinationWalletAddress: null,
                    amountAtomic: null,
                    expiresAt: null
                }));
                mainnetRequestRef.current = null;
                paymentReferenceRef.current = null;
                setTransferQr(null);
                setShowTransferQr(false);
                return;
            }
            if (paymentReferenceRef.current !== request.paymentReference) {
                setSentToWallet(submissionAttemptIsActive(localStorage, request.paymentReference));
            }
            mainnetRequestRef.current = request;
            setPayment((current) => ({
                ...current,
                ...request,
                status: current.status === "SETTLED" ? "SETTLED" : "AWAITING_PAYMENT",
                playerPaymentStatuses: current.playerPaymentStatuses ?? []
            }));
            paymentReferenceRef.current = request.paymentReference;
        }

        const requestStatus = () => {
            const paymentReference = paymentReferenceRef.current;
            socket.emit(PAYMENT_STATUS_REQUEST, createPaymentStatusRequest({
                roomId, playerId, paymentSubmissionAcknowledged:
                    hasSubmissionAcknowledgement(localStorage, paymentReference)
            }));
        };
        socket.on('connect', requestStatus);
        socket.on(PAYMENT_STATUS_EVENT, handlePaymentStatus);
        socket.on(PAYMENT_REQUEST_EVENT, handlePaymentRequest);

        // Re-request the authoritative payment state so a status event that
        // was emitted before this page subscribed is re-delivered now.
        if (requestedRef.current !== identityKey) {
            requestedRef.current = identityKey;
            socket.emit(PAYMENT_STATUS_REQUEST, createPaymentStatusRequest({ roomId, playerId }));
        }

        return () => {
            socket.off('connect', requestStatus);
            socket.off(PAYMENT_STATUS_EVENT, handlePaymentStatus);
            socket.off(PAYMENT_REQUEST_EVENT, handlePaymentRequest);
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
                socket.emit(PAYMENT_STATUS_REQUEST, createPaymentStatusRequest({
                    roomId, playerId, paymentSubmissionAcknowledged:
                        hasSubmissionAcknowledgement(localStorage, payment.paymentReference)
                }));
            }
        };
        const id = setInterval(check, 3000);
        return () => clearInterval(id);
    }, [roomId, playerId, payment.paymentAcceptanceEnabled,
        payment.status, payment.expiresAt, payment.paymentReference]);

    const walletMatches = payerMatchesConnectedWallet(payment.payerAddress, connectedWallet, payment.network);
    const mainnetRequestValid = mainnetMode
        && payment.roomId === roomId
        && payment.playerId === playerId
        && payment.paymentAcceptanceEnabled === true
        && status === "AWAITING_PAYMENT"
        && Number.isSafeInteger(payment.amountAtomic)
        && payment.amountAtomic > 0
        && typeof payment.paymentReference === "string"
        && Number.isSafeInteger(payment.expiresAt)
        && Date.now() < payment.expiresAt
        && typeof payment.destinationWalletAddress === "string"
        && typeof payment.payerAddress === "string";
    const payable = payment.paymentAcceptanceEnabled === true
        && status === "AWAITING_PAYMENT"
        && (mainnetMode ? mainnetRequestValid : true);

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
        if (submissionAttemptIsActive(localStorage, payment.paymentReference)) { setSentToWallet(true); return; }
        // Validate before claiming submission: an expired/invalid request must
        // not leave a permanent uncertain-payment lock in this browser.
        let transaction;
        try { transaction = buildRoomWalletTonConnectRequest(payment); }
        catch (error) { setPaymentError(error.message); return; }
        localStorage.setItem(attemptKey, PAYMENT_SUBMISSION_PENDING_STATE);
        paymentReferenceRef.current = payment.paymentReference;
        setSentToWallet(true);
        setSending(true);
        // This is only a request to inspect the shared room wallet. It is not
        // payment evidence; settlement still requires server-side chain proof.
        socket.emit(PAYMENT_STATUS_REQUEST, createPaymentStatusRequest({ roomId, playerId }));
        try {
            await tonConnectUI.sendTransaction(transaction);
            // TonConnect acknowledgement is NOT a blockchain confirmation.
            // Prevent repeat submits; only the server can mark the seat SETTLED.
            localStorage.setItem(attemptKey, PAYMENT_SUBMISSION_ACKNOWLEDGED_STATE);
            setSentToWallet(true);
            socket.emit(PAYMENT_STATUS_REQUEST, createPaymentStatusRequest({
                roomId, playerId, paymentSubmissionAcknowledged: true
            }));
        } catch (error) {
            if (error?.name === 'UserRejectsError') {
                localStorage.removeItem(attemptKey);
                setSentToWallet(false);
            } else {
                // Wallet errors can happen after the transfer was broadcast;
                // ask the server to inspect the chain without assuming success.
                localStorage.setItem(attemptKey, PAYMENT_SUBMISSION_UNKNOWN_STATE);
            }
            setPaymentError(error?.message ?? "Wallet rejected payment");
        } finally {
            setSending(false);
        }
    }

    function handleWalletConfirmation() {
        if (mainnetMode) {
            runMainnetPaymentAction({
                requestValid: mainnetRequestValid,
                connectedWallet,
                walletMatches,
                sending,
                sentToWallet,
                openWalletModal: () => tonConnectUI.openModal(),
                submitPayment: initiatePayment
            });
            return;
        }
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
                        YOUR NICKNAME: {localPlayer?.nickname ?? "—"} · {networkLabel}
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
                                    <strong>{mainnetMode
                                        ? getMainnetPlayerPaymentStatus(payment.playerPaymentStatuses
                                            ?.find(item => item.playerId === player.playerId)?.status)
                                        : status === "SETTLED" && player.isLocal
                                            ? "Payment verified"
                                            : "Waiting for payments"}</strong>
                                </div>
                            </article>
                        ))}
                    </div>

                    {mainnetMode && payment.paymentAcceptanceEnabled && payment.paymentReference ? (
                        <>
                            <div className="page4Payment__summary">
                                PAY (AMOUNT) TON: {amount ?? "—"} TON
                                {payment.destinationWalletAddress ? ` - ${payment.destinationWalletAddress}` : ""}
                            </div>
                            <p className="page4Payment__waiting">
                                {status === "SETTLED" ? "PAYMENT RECEIVED — WAITING FOR OTHER PLAYERS" : "WAITING FOR PAYMENT CONFIRMATION"}
                            </p>
                            {payable && <button className="page4Payment__confirm" type="button"
                                disabled={sending || sentToWallet || !mainnetRequestValid}
                                onClick={handleWalletConfirmation}>
                                {sending ? "OPENING WALLET…" : sentToWallet ? "PAYMENT SENT — WAITING FOR CONFIRMATION"
                                    : !connectedWallet ? "CONNECT MAINNET WALLET"
                                        : !walletMatches ? "SELECT MAINNET WALLET" : "PAY WITH TON CONNECT"}
                            </button>}
                            {connectedWallet && !walletMatches && payable && (
                                <p className="page4Payment__error" role="alert">
                                    Select the Mainnet wallet entered on Page3 before confirming.
                                </p>
                            )}
                            {paymentError && <p className="page4Payment__error" role="alert">{paymentError}</p>}
                        </>
                    ) : payment.paymentAcceptanceEnabled && !mainnetMode ? (
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
                                        onClick={() => {
                                            tonConnectUI.closeModal();
                                            const next = !showTransferQr;
                                            if (next) {
                                                localStorage.setItem('wheelwin:payment:' + payment.paymentReference, PAYMENT_QR_DISPLAYED_STATE);
                                                socket.emit(PAYMENT_STATUS_REQUEST, createPaymentStatusRequest({
                                                    roomId, playerId, trigger: "PAYMENT_QR_DISPLAYED"
                                                }));
                                            }
                                            setShowTransferQr(next);
                                        }}>
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
                            {mainnetMode
                                ? `Mainnet payments are unavailable. Do not send TON. Ledger status: ${payment.confirmedCount ?? 0}/3 confirmed.`
                                : payment.network === "testnet"
                                    ? "Payments are unavailable. Do not send GRAM to any room wallet."
                                    : "Checking payment availability. Do not send funds to any room wallet."}
                        </p>
                    )}
                </div>
            </section>
        </GameLayout>
    );
}
