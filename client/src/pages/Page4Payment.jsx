/**
 * WheelWin Page4 — Testnet Room Wallet entry payment.
 *
 * Player finance is Room-Wallet-only: ONE plain TON transfer through
 * TonConnect to the server-selected Room Wallet for the current room.
 *
 * - Destination and amount are server-authoritative (paymentSession snapshot
 *   carried by PAYMENT_SESSION_UPDATED / PAYMENT_SESSION_CREATED).
 * - sendTransaction success only emits PAYMENT_CONFIRM_INTENT; the server
 *   independently observes and verifies the blockchain payment.
 * - The client never selects a Room Wallet, never calculates the amount and
 *   never declares a blockchain payment confirmed by itself.
 * - GameEscrow / DepositPackage payment paths and diagnostic bypasses are not
 *   part of this component.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useTonConnectUI, useTonWallet } from "@tonconnect/ui-react";

import GameLayout from "../layouts/GameLayout";

import PlayerPaymentRow from "../components/PlayerPaymentRow";

import { useAuthoritativeSession } from "../context/AuthoritativeSessionContext";
import { useLanguage } from "../context/LanguageContext";
import { usePlayerIdentity } from "../context/PlayerIdentityContext";

import {
    canSubmitEntryPayment,
    getLocalPaymentRequest,
    mapPaymentSessionRows,
    mapWalletConnectionRows,
    PAGE4_PAYMENT_PHASE,
    PAYMENT_PARTICIPANT_STATUS,
    resolveEntryPaymentComponents,
    resolveLocalPlayerId,
    resolvePage4PaymentPhase,
    resolvePlayerPaymentDestination,
    shouldShowPaymentSessionRows,
    shouldShowWalletActions,
    WALLET_CONNECTION_STATUS
} from "../game/session";

import {
    buildEntryPaymentTransaction,
    nanotonsToTonDisplay,
    toTonConnectSendTransactionRequest
} from "../payment/buildEntryPaymentTransaction";

import { requiredGramToNanotonString } from "../payment/buildTonConnectPaymentTransaction";

import {
    toSessionWalletAddress,
    tonWalletAccountsEqual
} from "../utils/tonWalletAddress";

import socket from "../socket/socket";

import { LOBBY_OUTGOING_EVENTS } from "../socket/socketEvents";

import { launchGramWalletHandoff } from "../tonconnect/telegramMiniAppGramWalletHandoff";

import "../styles/page4payment.css";

/**
 * R7.26 — TonConnect SDK is the source of truth for connector state.
 */
function resolveTonConnectSdkAddress(tonConnectUI, tonWallet) {

    return tonWallet?.account?.address
        ?? tonConnectUI?.wallet?.account?.address
        ?? tonConnectUI?.account?.address
        ?? null;

}

function isTonConnectSdkConnected(tonConnectUI, tonWallet) {

    return tonConnectUI?.connected === true
        || tonConnectUI?.connector?.connected === true
        || Boolean(resolveTonConnectSdkAddress(tonConnectUI, tonWallet));

}

/**
 * A new connector.connect() / openModal() is allowed only when every SDK
 * indicator says NOT CONNECTED. An already-connected session is reused.
 */
function mayInitiateTonConnectConnect(tonConnectUI, tonWallet) {

    return !isTonConnectSdkConnected(tonConnectUI, tonWallet);

}

/**
 * Authoritative payment-session states mapped to the Page4 UI. All states are
 * derived from server-owned data only — the client never invents a successful
 * payment state on its own.
 */
export const PAGE4_PAYMENT_UI_STATE = Object.freeze({
    WAITING_FOR_PAYMENT: "WAITING_FOR_PAYMENT",
    PAYMENT_SUBMITTING: "PAYMENT_SUBMITTING",
    PAYMENT_PENDING: "PAYMENT_PENDING",
    PAYMENT_CONFIRMED: "PAYMENT_CONFIRMED",
    PAYMENT_FAILED: "PAYMENT_FAILED",
    ROOM_EXPIRED: "ROOM_EXPIRED"
});

const ROOM_EXPIRED_SESSION_STATUSES = new Set([
    "FAILED",
    "PAYMENT_TIMEOUT"
]);

const PENDING_SEAT_STATUSES = new Set([
    PAYMENT_PARTICIPANT_STATUS.PAYMENT_SUBMITTED,
    PAYMENT_PARTICIPANT_STATUS.BLOCKCHAIN_PENDING
]);

const FAILED_CONFIRMATION_STATUSES = new Set([
    "FAILED",
    "REJECTED"
]);

export function resolvePage4PaymentUiState({
    paymentSession = null,
    localParticipant = null,
    submitting = false
} = {}) {

    const sessionStatus = String(paymentSession?.status ?? "").trim();

    // Server deadline expired / session failed → the server destroys the room
    // and its existing payment/recovery system handles refunds.
    if (ROOM_EXPIRED_SESSION_STATUSES.has(sessionStatus)) {

        return PAGE4_PAYMENT_UI_STATE.ROOM_EXPIRED;

    }

    if (
        sessionStatus === "COMPLETED"
        || localParticipant?.status === PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED
    ) {

        return PAGE4_PAYMENT_UI_STATE.PAYMENT_CONFIRMED;

    }

    if (PENDING_SEAT_STATUSES.has(localParticipant?.status)) {

        return PAGE4_PAYMENT_UI_STATE.PAYMENT_PENDING;

    }

    if (submitting) {

        return PAGE4_PAYMENT_UI_STATE.PAYMENT_SUBMITTING;

    }

    if (
        localParticipant?.status === PAYMENT_PARTICIPANT_STATUS.PAYMENT_FAILED
        || FAILED_CONFIRMATION_STATUSES.has(localParticipant?.confirmationStatus)
    ) {

        return PAGE4_PAYMENT_UI_STATE.PAYMENT_FAILED;

    }

    return PAGE4_PAYMENT_UI_STATE.WAITING_FOR_PAYMENT;

}

function shortenTonAddress(address) {

    const value = String(address ?? "").trim();

    if (!value) {

        return "—";

    }

    if (value.length <= 14) {

        return value;

    }

    return `${value.slice(0, 8)}…${value.slice(-4)}`;

}

export default function Page4Payment({ onNavigate }) {

    // P6.2 — wallet connection; P6.3 — authoritative Payment Session after READY.
    // P6.7 — Page4 stays open until the server moves the game to Page5.
    const authoritative = useAuthoritativeSession();

    const { t } = useLanguage();

    const { identity } = usePlayerIdentity();

    const [tonConnectUI] = useTonConnectUI();

    const tonWallet = useTonWallet();

    const [connecting, setConnecting] = useState(false);

    const [localError, setLocalError] = useState("");

    const [submitting, setSubmitting] = useState(false);

    const [submitError, setSubmitError] = useState("");

    const [tonConnectUniversalLink, setTonConnectUniversalLink] = useState("");

    const [copied, setCopied] = useState(false);

    // R7.36 — one STARTED+REPORT pair per wallet proof until disconnect.
    const lastWalletProofEmitRef = useRef(null);

    const prevTonWalletRef = useRef(undefined);

    const tonConnectUniversalLinkRef = useRef("");

    const walletConnection = authoritative.walletConnection;

    const paymentSession = authoritative.paymentSession;

    const paymentConnectionReady = authoritative.lifecycle
        ?.paymentConnectionReady === true;

    const resolvedIdentityPlayerId = resolveLocalPlayerId(
        identity.playerId ?? null,
        authoritative.players,
        {
            verifyCompleted: Boolean(authoritative.lifecycle?.verifyCompleted)
        }
    );

    // Page4 seat recovery is anchored to the authoritative wallet binding.
    // TonConnect may expose a raw address while the Page3 session wallet is
    // friendly (for example 0Q... on Testnet). Account equality must ignore
    // friendly-format flags while preserving the displayed session value.
    const connectedWalletRawAddress =
        lastWalletProofEmitRef.current
        ?? resolveTonConnectSdkAddress(tonConnectUI, tonWallet);

    const paymentParticipantForConnectedWallet =
        Array.isArray(paymentSession?.participants)
            ? paymentSession.participants.find((participant) => {
                const candidate =
                    participant?.walletAddress
                    ?? participant?.wallet
                    ?? null;

                return Boolean(candidate)
                    && Boolean(connectedWalletRawAddress)
                    && tonWalletAccountsEqual(
                        candidate,
                        connectedWalletRawAddress
                    );
            }) ?? null
            : null;

    const localPlayerId = paymentParticipantForConnectedWallet?.playerId
        ?? resolvedIdentityPlayerId;

    const paymentPhase = resolvePage4PaymentPhase({
        paymentSession,
        gameContract: null,
        paymentConnectionReady,
        localPlayerId
    });

    const walletPhase = shouldShowWalletActions(paymentPhase);

    const showPaymentRows = shouldShowPaymentSessionRows(paymentPhase);

    const inPostWalletPhase = paymentPhase !== PAGE4_PAYMENT_PHASE.WALLET;

    // The ONLY payment destination is the server-selected Room Wallet.
    const roomWalletDestination = resolvePlayerPaymentDestination({
        paymentSession,
        localPlayerId
    });

    const roomWalletPaymentReady =
        Boolean(paymentSession?.roomWalletAddress)
        && (
            paymentSession?.status === "ACTIVE"
            || paymentSession?.status === "WAITING_FOR_PAYMENTS"
            || paymentSession?.status === "PARTIALLY_PAID"
            || paymentSession?.status === "RECOVERED"
        );

    const localParticipantPaymentReady =
        paymentParticipantForConnectedWallet?.status
            === PAYMENT_PARTICIPANT_STATUS.AWAITING_PLAYER_CONFIRMATION
        || paymentParticipantForConnectedWallet?.status
            === PAYMENT_PARTICIPANT_STATUS.PAYMENT_REQUESTED
        || canSubmitEntryPayment({
            paymentSession,
            gameContract: null,
            localPlayerId
        });

    // Do not hide the payment action because localPlayerId was temporarily
    // unresolved during a React/TonConnect synchronization frame.
    const entryActionEnabled = roomWalletPaymentReady
        && Boolean(localPlayerId)
        && localParticipantPaymentReady;

    const uiState = resolvePage4PaymentUiState({
        paymentSession,
        localParticipant: paymentParticipantForConnectedWallet,
        submitting
    });

    const walletPlayers = useMemo(
        () => mapWalletConnectionRows(
            walletConnection,
            authoritative.players
        ),
        [walletConnection, authoritative.players]
    );

    const paymentPlayers = useMemo(
        () => mapPaymentSessionRows(
            paymentSession,
            authoritative.players
        ),
        [paymentSession, authoritative.players]
    );

    const players = showPaymentRows ? paymentPlayers : walletPlayers;

    const localWalletSeat = useMemo(
        () => walletPlayers.find(
            (player) => String(player.playerId) === String(localPlayerId)
        ) ?? null,
        [walletPlayers, localPlayerId]
    );

    const localWalletStatus = localWalletSeat?.status
        ?? WALLET_CONNECTION_STATUS.WAITING;

    // R7.26 — gate Connect on the server seat + SDK. ADDRESS_MISMATCH requires
    // Disconnect before a new connect is allowed. SDK-connected + WAITING
    // still enables Connect (reuse path, no openModal).
    const canConnect = walletPhase
        && localWalletStatus !== WALLET_CONNECTION_STATUS.CONNECTED
        && localWalletStatus !== WALLET_CONNECTION_STATUS.CONNECTING
        && localWalletStatus !== WALLET_CONNECTION_STATUS.ADDRESS_MISMATCH
        && !connecting;

    const localPaymentRequest = useMemo(
        () => getLocalPaymentRequest(paymentSession, localPlayerId),
        [paymentSession, localPlayerId]
    );

    const myNickname = authoritative.players?.[localPlayerId]?.nickname ?? null;

    // Server-authoritative amount (GRM) → display string. The client only
    // formats the value; it never computes or alters the payment amount.
    const amountLabel = useMemo(() => {

        if (!localPaymentRequest?.requiredGram) {

            return null;

        }

        try {

            return nanotonsToTonDisplay(
                requiredGramToNanotonString(localPaymentRequest.requiredGram)
            );

        } catch {

            return null;

        }

    }, [localPaymentRequest?.requiredGram]);

    const paymentSummaryText = roomWalletDestination
        ? `${t("payment.payAmount")}: ${amountLabel ?? "—"} TON`
            + ` · ${shortenTonAddress(roomWalletDestination)}`
        : null;

    const statusText = useMemo(() => {

        if (walletPhase) {

            return null;

        }

        switch (uiState) {

            case PAGE4_PAYMENT_UI_STATE.WAITING_FOR_PAYMENT:
                return t("payment.waitingForPayments");

            case PAGE4_PAYMENT_UI_STATE.PAYMENT_SUBMITTING:
                return t("payment.openingWallet");

            case PAGE4_PAYMENT_UI_STATE.PAYMENT_PENDING:
                return t("payment.waitingBlockchain");

            case PAGE4_PAYMENT_UI_STATE.PAYMENT_CONFIRMED:
                return paymentSession?.status === "COMPLETED"
                    ? t("payment.allConfirmed")
                    : t("payment.paymentConfirmed");

            case PAGE4_PAYMENT_UI_STATE.PAYMENT_FAILED:
                return t("payment.failed");

            case PAGE4_PAYMENT_UI_STATE.ROOM_EXPIRED:
                return t("payment.sessionFailed");

            default:
                return null;

        }

    }, [uiState, walletPhase, paymentSession?.status, t]);

    // The payment button is shown exactly when payment is required from the
    // local player and the server has published an actionable Room Wallet.
    const showPaymentButton = !walletPhase
        && roomWalletPaymentReady
        && uiState === PAGE4_PAYMENT_UI_STATE.WAITING_FOR_PAYMENT;

    const showDesktopConnection = Boolean(tonConnectUniversalLink)
        && !tonWallet?.account?.address;

    const emitWalletSocketEvent = useCallback((event, payload) => {

        console.log("[Page4Payment] socket.emit", {
            event,
            roomId: authoritative.roomId ?? null,
            playerId: localPlayerId
        });

        if (payload === undefined) {

            socket.emit(event);

        } else {

            socket.emit(event, payload);

        }

    }, [authoritative.roomId, localPlayerId]);

    const reportConnectedWallet = useCallback((rawAddress) => {

        const connectedWallet = toSessionWalletAddress(rawAddress);

        if (!connectedWallet) {

            console.log("[Page4Payment] wallet report aborted | no address");

            setLocalError(t("payment.walletMismatch"));

            return;

        }

        // R7.36 — STARTED only after a wallet proof exists, once per proof.
        if (lastWalletProofEmitRef.current !== connectedWallet) {

            lastWalletProofEmitRef.current = connectedWallet;

            emitWalletSocketEvent(
                LOBBY_OUTGOING_EVENTS.WALLET_CONNECT_STARTED
            );

        }

        emitWalletSocketEvent(
            LOBBY_OUTGOING_EVENTS.WALLET_CONNECT_REPORT,
            {
                roomId: authoritative.roomId ?? null,
                playerId: localPlayerId,
                connectedWallet
            }
        );

    }, [authoritative.roomId, emitWalletSocketEvent, localPlayerId, t]);

    // Keep the server wallet session synchronized with the TonConnect SDK.
    // Reconnect / reload: the SDK restores the wallet and this effect re-reports
    // the SAME proof; the server session stays untouched (idempotent).
    useEffect(() => {

        prevTonWalletRef.current = tonWallet ?? null;

        const nextAddress = tonWallet?.account?.address ?? null;

        if (!nextAddress) {

            // R7.36 — allow STARTED again after the SDK clears the wallet.
            lastWalletProofEmitRef.current = null;

            return;

        }

        if (inPostWalletPhase) {

            return;

        }

        // Already synchronized for this room seat — do not re-emit.
        if (localWalletStatus === WALLET_CONNECTION_STATUS.CONNECTED) {

            return;

        }

        // Wrong wallet already classified — Disconnect is required.
        if (localWalletStatus === WALLET_CONNECTION_STATUS.ADDRESS_MISMATCH) {

            return;

        }

        setConnecting(false);

        reportConnectedWallet(nextAddress);

    }, [
        tonWallet,
        tonConnectUI,
        localWalletStatus,
        inPostWalletPhase,
        reportConnectedWallet
    ]);

    // Desktop / Gram-Wallet handoff: capture the TonConnect universal link
    // produced by connector.connect without altering the SDK return identity.
    useEffect(() => {

        const connector = tonConnectUI?.connector;

        if (!connector || typeof connector.connect !== "function") {

            return undefined;

        }

        const originalConnect = connector.connect.bind(connector);

        connector.connect = (...args) => {

            // Never start a second connect while a session is already active.
            if (connector.connected === true) {

                return undefined;

            }

            const result = originalConnect(...args);

            const captureLink = (link) => {

                if (typeof link === "string" && link.length > 0) {

                    tonConnectUniversalLinkRef.current = link;

                    setTonConnectUniversalLink(link);

                    setCopied(false);

                }

                return link;

            };

            if (typeof result === "string") {

                captureLink(result);

            } else if (result && typeof result.then === "function") {

                result.then(captureLink).catch(() => undefined);

            }

            return result;

        };

        return () => {

            connector.connect = originalConnect;

        };

    }, [tonConnectUI]);

    // Modal lifecycle: clear the captured link when the modal closes and
    // report a disconnect when it closed without a connected wallet.
    useEffect(() => {

        const unsubscribe = tonConnectUI.onModalStateChange((state) => {

            const isOpen = state?.status === "opened";

            if (isOpen) {

                return;

            }

            tonConnectUniversalLinkRef.current = "";

            setTonConnectUniversalLink("");

            setCopied(false);

            if (state?.status === "closed" && !tonConnectUI.wallet) {

                setConnecting(false);

                // Modal closed without proof; no STARTED was owed.
                lastWalletProofEmitRef.current = null;

                emitWalletSocketEvent(
                    LOBBY_OUTGOING_EVENTS.WALLET_DISCONNECT_REPORT
                );

            }

        });

        return () => {

            unsubscribe?.();

        };

    }, [tonConnectUI, emitWalletSocketEvent]);

    async function handleConnectWallet() {

        const sdkConnected = isTonConnectSdkConnected(tonConnectUI, tonWallet);

        const mayInitiateConnect = mayInitiateTonConnectConnect(
            tonConnectUI,
            tonWallet
        );

        console.log("[Page4Payment] connect wallet click", {
            roomId: authoritative.roomId ?? null,
            playerId: localPlayerId,
            canConnect,
            sdkConnected,
            mayInitiateConnect
        });

        if (!canConnect) {

            return;

        }

        setLocalError("");

        // R7.26 — SDK already connected: reuse the wallet, never re-open.
        if (!mayInitiateConnect) {

            const sdkAddress = resolveTonConnectSdkAddress(tonConnectUI, tonWallet);

            if (!sdkAddress) {

                setLocalError(t("payment.telegramSessionNoAddress"));

                return;

            }

            setConnecting(false);

            reportConnectedWallet(sdkAddress);

            return;

        }

        setConnecting(true);

        try {

            await tonConnectUI.openModal();

        } catch (error) {

            console.error("[Page4Payment] TonConnect modal failed:", error);

            setConnecting(false);

            emitWalletSocketEvent(
                LOBBY_OUTGOING_EVENTS.WALLET_DISCONNECT_REPORT
            );

            setLocalError(t("payment.unableOpenTelegramWallet"));

        }

    }

    async function handleDisconnectWallet() {

        setLocalError("");

        lastWalletProofEmitRef.current = null;

        try {

            await tonConnectUI.disconnect();

        } catch (error) {

            console.error("[Page4Payment] TonConnect disconnect failed:", error);

            // Still report the disconnect so the room returns to WAITING.
        }

        emitWalletSocketEvent(LOBBY_OUTGOING_EVENTS.WALLET_DISCONNECT_REPORT);

        setConnecting(false);

    }

    async function handleCopyTonConnectLink() {

        const link = tonConnectUniversalLinkRef.current
            || tonConnectUniversalLink;

        if (!link) {

            return;

        }

        try {

            if (navigator.clipboard?.writeText) {

                await navigator.clipboard.writeText(link);

            } else {

                const textArea = document.createElement("textarea");

                textArea.value = link;

                document.body.appendChild(textArea);

                textArea.select();

                document.execCommand("copy");

                document.body.removeChild(textArea);

            }

            setCopied(true);

        } catch {

            setCopied(false);

        }

    }

    function handleOpenTonConnectLink() {

        const link = tonConnectUniversalLinkRef.current
            || tonConnectUniversalLink;

        if (!link) {

            return;

        }

        launchGramWalletHandoff(link);

    }

    /**
     * Room Wallet entry payment.
     *
     * 1. Reads the server-authoritative Room Wallet destination.
     * 2. Reads the server-authoritative amount (requiredGram).
     * 3. Builds ONE plain TON transfer (no payload / stateInit).
     * 4. Sends it through TonConnect.
     * 5. On wallet success emits PAYMENT_CONFIRM_INTENT only — the server
     *    independently verifies the blockchain payment and owns confirmation.
     */
    async function handleConfirmInTelegramWallet() {

        if (submitting) {

            return;

        }

        if (!tonConnectUI?.sendTransaction) {

            setSubmitError(t("payment.telegramNotConnected"));

            return;

        }

        if (!tonWallet?.account?.address && !tonConnectUI?.account?.address) {

            setSubmitError(t("payment.telegramNotConnected"));

            return;

        }

        const connectedWalletAddress =
            lastWalletProofEmitRef.current
            ?? resolveTonConnectSdkAddress(tonConnectUI, tonWallet);

        const runtimeParticipant =
            Array.isArray(paymentSession?.participants)
                ? paymentSession.participants.find((participant) => {
                    const candidate =
                        participant?.walletAddress
                        ?? participant?.wallet
                        ?? null;

                    return Boolean(candidate)
                        && Boolean(connectedWalletAddress)
                        && tonWalletAccountsEqual(
                            candidate,
                            connectedWalletAddress
                        );
                }) ?? null
                : null;

        const runtimeLocalPlayerId =
            runtimeParticipant?.playerId
            ?? localPlayerId
            ?? identity.playerId
            ?? null;

        const paymentRequest = getLocalPaymentRequest(
            paymentSession,
            runtimeLocalPlayerId
        );

        const destination = resolvePlayerPaymentDestination({
            paymentSession,
            localPlayerId: runtimeLocalPlayerId
        });

        if (!destination) {

            setSubmitError(t("payment.stakeUnavailable"));

            return;

        }

        if (!canSubmitEntryPayment({
            paymentSession,
            gameContract: null,
            localPlayerId: runtimeLocalPlayerId
        })) {

            setSubmitError(t("payment.stakeUnavailable"));

            return;

        }

        setSubmitting(true);

        setSubmitError("");

        try {

            const components = resolveEntryPaymentComponents({
                paymentSession,
                gameContract: null,
                localPlayerId: runtimeLocalPlayerId
            });

            const transactionObject = buildEntryPaymentTransaction({
                includeStake: components.includeStake,
                paymentDestination: destination,
                roomWalletAddress: destination,
                requiredGram: paymentRequest?.requiredGram ?? null
            });

            const tonConnectTransaction = toTonConnectSendTransactionRequest(
                transactionObject
            );

            console.log("[Page4Payment] Room Wallet transfer request", {
                roomId: authoritative.roomId ?? null,
                network: paymentSession?.network ?? null,
                playerId: runtimeLocalPlayerId,
                destination,
                totalNanotons: transactionObject.totalNanotons,
                validUntil: tonConnectTransaction.validUntil,
                messageCount: tonConnectTransaction.messages.length
            });

            const walletResult = await tonConnectUI.sendTransaction(
                tonConnectTransaction
            );

            console.log("[Page4Payment] wallet accepted the transfer", {
                result: walletResult ?? null
            });

            // Intent only — the server confirms after its own blockchain
            // observation of the Room Wallet.
            socket.emit(LOBBY_OUTGOING_EVENTS.PAYMENT_CONFIRM_INTENT);

        } catch (error) {

            console.error(
                "[Page4Payment] Room Wallet transfer failed:",
                error
            );

            setSubmitError(error?.message || t("payment.entryFailed"));

        } finally {

            setSubmitting(false);

        }

    }

    return (

        <GameLayout

            message={t("page.payment.title")}

            backEnabled={walletPhase}

            onBack={() => onNavigate(5)}

            nextEnabled={false}

            onNext={() => {}}

        >

            <div className="page4">

                <div className="paymentPanel">

                    {(myNickname || paymentSession?.network) && (

                        <div className="smartContractStatus">

                            {myNickname
                                ? `${t("player.yourNickname")}: ${myNickname}`
                                : null}

                            {paymentSession?.network
                                ? ` · ${String(paymentSession.network).toUpperCase()}`
                                : null}

                        </div>

                    )}

                    <div className="paymentPlayers">

                        {players.map((player) => (

                            <PlayerPaymentRow

                                key={player.key}

                                labelTitle={player.labelTitle}

                                nickname={player.nickname}

                                icon={player.icon}

                                connectionStatus={
                                    showPaymentRows
                                        ? undefined
                                        : player.status
                                }

                                connectionStatusLabel={
                                    showPaymentRows
                                        ? undefined
                                        : player.statusLabel
                                }

                                paymentStatus={
                                    showPaymentRows
                                        ? player.status
                                        : undefined
                                }

                                paymentStatusLabel={
                                    showPaymentRows
                                        ? player.statusLabel
                                        : undefined
                                }

                                walletRegistered={
                                    showPaymentRows
                                        ? Boolean(player.wallet)
                                        : undefined
                                }

                            />

                        ))}

                    </div>

                    {localError && (

                        <div
                            className="paymentPlayersWaiting"
                            aria-live="assertive"
                        >

                            {localError}

                        </div>

                    )}

                    <div className="page4__connectActions">

                        {submitError && (

                            <div
                                className="paymentPlayersWaiting"
                                aria-live="assertive"
                            >

                                {submitError}

                            </div>

                        )}

                        {paymentSummaryText ? (

                            <div className="smartContractStatus">

                                {paymentSummaryText}

                            </div>

                        ) : null}

                        {statusText ? (

                            <div className="smartContractStatus">

                                {statusText}

                            </div>

                        ) : null}

                        {showPaymentButton && (

                            <button

                                type="button"

                                className="page4__connectButton"

                                disabled={!entryActionEnabled || submitting}

                                onClick={handleConfirmInTelegramWallet}

                            >

                                {submitting
                                    ? t("payment.openingWallet")
                                    : t("payment.confirmInWallet")}

                            </button>

                        )}

                        {walletPhase && canConnect && (

                            <button

                                type="button"

                                className="page4__connectButton"

                                disabled={!canConnect}

                                onClick={handleConnectWallet}

                            >

                                {connecting
                                    ? t("payment.connecting")
                                    : t("payment.connectWallet")}

                            </button>

                        )}

                        {walletPhase
                            && localWalletStatus
                                === WALLET_CONNECTION_STATUS.CONNECTED && (

                            <button

                                type="button"

                                className="page4__disconnectButton"

                                onClick={handleDisconnectWallet}

                            >

                                {t("payment.disconnect")}

                            </button>

                        )}

                        {showDesktopConnection && (

                            <div className="page4__desktopConnection">

                                <div className="page4__desktopConnectionTitle">

                                    {t("payment.desktopConnection")}

                                </div>

                                <label
                                    className="page4__desktopConnectionLabel"
                                    htmlFor="page4-tonconnect-link"
                                >

                                    {t("payment.universalLink")}

                                </label>

                                <div className="page4__desktopConnectionRow">

                                    <input

                                        id="page4-tonconnect-link"

                                        className="page4__desktopConnectionInput"

                                        type="text"

                                        readOnly

                                        value={tonConnectUniversalLink}

                                        onFocus={(event) => {
                                            event.target.select();
                                        }}

                                    />

                                </div>

                                <div className="page4__desktopConnectionActions">

                                    <button

                                        type="button"

                                        className="page4__desktopConnectionCopy"

                                        onClick={handleCopyTonConnectLink}

                                    >

                                        {copied
                                            ? t("common.copied")
                                            : t("common.copy")}

                                    </button>

                                    <button

                                        type="button"

                                        className="page4__desktopConnectionOpen"

                                        onClick={handleOpenTonConnectLink}

                                    >

                                        {t("payment.openWallet")}

                                    </button>

                                </div>

                            </div>

                        )}

                    </div>

                </div>

            </div>

        </GameLayout>

    );

}










