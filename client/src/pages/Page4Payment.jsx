import { useCallback, useEffect, useMemo, useState } from "react";

import { useTonConnectUI, useTonWallet } from "@tonconnect/ui-react";

import GameLayout from "../layouts/GameLayout";

import PlayerPaymentRow from "../components/PlayerPaymentRow";

import { useAuthoritativeSession } from "../context/AuthoritativeSessionContext";
import { useLanguage } from "../context/LanguageContext";
import { usePlayerIdentity } from "../context/PlayerIdentityContext";

import {
    canConfirmLocalPayment,
    getLocalPaymentRequest,
    hasPaymentSession,
    isGameContractDeployed,
    mapGameContractStatusLabel,
    mapPaymentSessionRows,
    mapWalletConnectionRows,
    shouldShowPaymentSessionWaiting,
    shouldShowWalletConnectionWaiting,
    WALLET_CONNECTION_STATUS
} from "../game/session";

import { resolveLocalPlayerId } from "../game/session";

import { toSessionWalletAddress } from "../utils/tonWalletAddress";

import socket from "../socket/socket";

import { LOBBY_OUTGOING_EVENTS } from "../socket/socketEvents";

import "../styles/page4payment.css";

export default function Page4Payment({ onNavigate }) {

    // P6.2 — wallet connection; P6.3 — authoritative Payment Session after READY.
    // P6.7 — Page4 stays open until server OPEN_PAGE5 (never local navigation).
    const authoritative = useAuthoritativeSession();

    const { t } = useLanguage();

    const { identity } = usePlayerIdentity();

    const [tonConnectUI] = useTonConnectUI();

    const tonWallet = useTonWallet();

    const [localError, setLocalError] = useState("");

    const [connecting, setConnecting] = useState(false);

    const [confirmingPayment, setConfirmingPayment] = useState(false);

    const walletConnection = authoritative.walletConnection;

    const paymentSession = authoritative.paymentSession;

    const gameContract = authoritative.gameContract;

    const paymentConnectionReady = authoritative.lifecycle
        ?.paymentConnectionReady === true;

    const inPaymentPhase = paymentConnectionReady
        || hasPaymentSession(paymentSession);

    const contractStatusLabel = gameContract?.status
        ? mapGameContractStatusLabel(gameContract.status)
        : null;

    const waiting = inPaymentPhase
        ? shouldShowPaymentSessionWaiting(paymentSession)
        : shouldShowWalletConnectionWaiting(walletConnection);

    const localPlayerId = resolveLocalPlayerId(
        identity.playerId ?? null,
        authoritative.players,
        {
            verifyCompleted: Boolean(authoritative.lifecycle?.verifyCompleted)
        }
    );

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

    const players = inPaymentPhase ? paymentPlayers : walletPlayers;

    const localWalletSeat = useMemo(
        () => walletPlayers.find(
            (player) => String(player.playerId) === String(localPlayerId)
        ) ?? null,
        [walletPlayers, localPlayerId]
    );

    const localWalletStatus = localWalletSeat?.status
        ?? WALLET_CONNECTION_STATUS.WAITING;

    const canConnect = !inPaymentPhase
        && localWalletStatus !== WALLET_CONNECTION_STATUS.CONNECTED
        && localWalletStatus !== WALLET_CONNECTION_STATUS.CONNECTING
        && !connecting;

    const canConfirm = canConfirmLocalPayment(paymentSession, localPlayerId)
        && isGameContractDeployed(gameContract);

    const localPaymentRequest = useMemo(
        () => getLocalPaymentRequest(paymentSession, localPlayerId),
        [paymentSession, localPlayerId]
    );

    const reportConnectedWallet = useCallback((rawAddress) => {

        // R6.3 TEMP DEBUG — remove after runtime trace
        console.log("======== REPORT CONNECTED WALLET ========", {
            rawAddress,
            timestamp: Date.now()
        });

        const connectedWallet = toSessionWalletAddress(rawAddress);

        // R6.3 TEMP DEBUG — remove after runtime trace
        console.log("[R6.3 TRACE] toSessionWalletAddress result", {
            connectedWallet
        });

        if (!connectedWallet) {

            // R6.3 TEMP DEBUG — remove after runtime trace
            console.log(
                "[R6.3 TRACE] REPORT ABORTED because connectedWallet == null"
            );
            console.log(
                "[R6.3 TRACE] EARLY RETURN | reason=connectedWallet == null"
            );

            setLocalError(
                "Connected wallet does not match the wallet entered during VERIFY."
            );

            return;

        }

        const reportPayload = {
            roomId: authoritative.roomId ?? null,
            playerId: localPlayerId,
            connectedWallet
        };

        // R6.3 TEMP DEBUG — remove after runtime trace
        console.log(
            "[R6.3 TRACE] emitting WALLET_CONNECT_REPORT payload",
            reportPayload
        );

        socket.emit(LOBBY_OUTGOING_EVENTS.WALLET_CONNECT_REPORT, reportPayload);

    }, [authoritative.roomId, localPlayerId]);

    useEffect(() => {

        // R6.3 TEMP DEBUG — remove after runtime trace
        console.log("======== TON WALLET UPDATE ========", {
            tonWallet,
            account: tonWallet?.account ?? null,
            address: tonWallet?.account?.address ?? null,
            network: tonWallet?.account?.chain ?? null,
            walletApp: tonWallet?.device?.appName
                ?? tonWallet?.device?.appVersion
                ?? tonWallet?.name
                ?? null,
            device: tonWallet?.device ?? null,
            timestamp: Date.now()
        });

        if (!tonWallet?.account?.address) {

            // R6.3 TEMP DEBUG — remove after runtime trace
            console.log(
                "[R6.3 TRACE] EARLY RETURN | reason=no tonWallet.account.address"
            );

            return;

        }

        setConnecting(false);

        reportConnectedWallet(tonWallet.account.address);

    }, [tonWallet, reportConnectedWallet]);

    useEffect(() => {

        if (localWalletStatus === WALLET_CONNECTION_STATUS.ADDRESS_MISMATCH) {

            setLocalError(
                "Connected wallet does not match the wallet entered during VERIFY."
            );

            return;

        }

        if (localWalletStatus === WALLET_CONNECTION_STATUS.CONNECTED) {

            setLocalError("");

        }

    }, [localWalletStatus]);

    useEffect(() => {

        const unsubscribe = tonConnectUI.onModalStateChange((state) => {

            if (state?.status === "closed" && !tonConnectUI.wallet) {

                setConnecting(false);

                if (localWalletStatus === WALLET_CONNECTION_STATUS.CONNECTING) {

                    // R6.3 TEMP DEBUG — remove after runtime trace
                    console.log(
                        "[R6.3 TRACE] modal closed without wallet → WALLET_DISCONNECT_REPORT",
                        { localWalletStatus }
                    );

                    socket.emit(LOBBY_OUTGOING_EVENTS.WALLET_DISCONNECT_REPORT);

                }

            }

        });

        return () => {

            unsubscribe?.();

        };

    }, [tonConnectUI, localWalletStatus]);

    async function handleConnectWallet() {

        // R6.3 TEMP DEBUG — remove after runtime trace
        console.log("======== CONNECT BUTTON ========", {
            timestamp: Date.now(),
            roomId: authoritative.roomId ?? null,
            playerId: localPlayerId,
            canConnect,
            currentStatus: localWalletStatus,
            paymentPhase: inPaymentPhase,
            callingOpenModal: true
        });

        if (!canConnect) {

            // R6.3 TEMP DEBUG — remove after runtime trace
            console.log(
                "[R6.3 TRACE] EARLY RETURN | reason=canConnect == false",
                {
                    localWalletStatus,
                    inPaymentPhase,
                    connecting
                }
            );

            return;

        }

        setLocalError("");

        setConnecting(true);

        socket.emit(LOBBY_OUTGOING_EVENTS.WALLET_CONNECT_STARTED);

        try {

            await tonConnectUI.openModal();

            // R6.3 TEMP DEBUG — remove after runtime trace
            console.log("[R6.3 TRACE] openModal returned");

        } catch (error) {

            // R6.3 TEMP DEBUG — remove after runtime trace
            console.log("[R6.3 TRACE] openModal exception thrown", {
                error: error?.message ?? String(error)
            });
            console.log(
                "[R6.3 TRACE] EARLY RETURN | reason=openModal exception"
            );

            setConnecting(false);

            socket.emit(LOBBY_OUTGOING_EVENTS.WALLET_DISCONNECT_REPORT);

            setLocalError("Unable to open Telegram Wallet.");

        }

    }

    async function handleDisconnectWallet() {

        setLocalError("");

        try {

            await tonConnectUI.disconnect();

        } catch {

            // Still report disconnect so the room returns to WAITING.
        }

        socket.emit(LOBBY_OUTGOING_EVENTS.WALLET_DISCONNECT_REPORT);

        setConnecting(false);

    }

    async function handleConfirmPayment() {

        if (!canConfirm || confirmingPayment) {

            return;

        }

        setLocalError("");

        setConfirmingPayment(true);

        try {

            const contractAddress = localPaymentRequest?.contractAddress
                ?? gameContract?.contractAddress
                ?? null;

            // Prefer official Telegram Wallet confirmation when a wallet session
            // is connected. Stub deploy addresses may be rejected by the wallet;
            // in that case Page4 confirmation still reports the user action.
            if (tonWallet && contractAddress && tonConnectUI?.sendTransaction) {

                try {

                    await tonConnectUI.sendTransaction({
                        validUntil: Math.floor(Date.now() / 1000) + 600,
                        messages: [
                            {
                                address: contractAddress,
                                amount: "1"
                            }
                        ]
                    });

                } catch {

                    // Wallet rejected/cancelled the chain payload — fall through
                    // to explicit intent reporting from this CONFIRM action only
                    // when the user still wants to proceed via Page4 stub path.
                }

            }

            socket.emit(LOBBY_OUTGOING_EVENTS.PAYMENT_CONFIRM_INTENT);

        } finally {

            setConfirmingPayment(false);

        }

    }

    function handleCancelPayment() {

        if (!canConfirm || confirmingPayment) {

            return;

        }

        socket.emit(LOBBY_OUTGOING_EVENTS.PAYMENT_CANCEL_INTENT);

    }

    return (

        <GameLayout

            message={t("page.payment.title")}

            backEnabled={!inPaymentPhase}

            onBack={() => onNavigate(5)}

            nextEnabled={false}

            onNext={() => {}}

        >

            <div className="page4">

                <div className="paymentPanel">

                    <div className="paymentPlayers">

                        {waiting ? (

                            <div
                                className="paymentPlayersWaiting"
                                aria-live="polite"
                            >

                                {inPaymentPhase
                                    ? "Preparing payment..."
                                    : "Waiting for payment..."}

                            </div>

                        ) : (

                            players.map((player) => (

                                <PlayerPaymentRow

                                    key={player.key}

                                    labelTitle={player.labelTitle}

                                    nickname={player.nickname}

                                    icon={player.icon}

                                    connectionStatus={
                                        inPaymentPhase
                                            ? undefined
                                            : player.status
                                    }

                                    connectionStatusLabel={
                                        inPaymentPhase
                                            ? undefined
                                            : player.statusLabel
                                    }

                                    paymentStatus={
                                        inPaymentPhase
                                            ? player.status
                                            : undefined
                                    }

                                    paymentStatusLabel={
                                        inPaymentPhase
                                            ? player.statusLabel
                                            : undefined
                                    }

                                    walletRegistered={
                                        inPaymentPhase
                                            ? Boolean(player.wallet)
                                            : undefined
                                    }

                                />

                            ))

                        )}

                    </div>

                    {localError && (

                        <div
                            className="paymentPlayersWaiting"
                            aria-live="assertive"
                        >

                            {localError}

                        </div>

                    )}

                    {inPaymentPhase ? (

                        <div className="page4__connectActions">

                            <div
                                className="smartContractStatus"
                                aria-live="polite"
                            >

                                Wallet Connected

                            </div>

                            {contractStatusLabel && (

                                <div
                                    className="smartContractStatus"
                                    aria-live="polite"
                                >

                                    <div>Game Contract</div>

                                    <div>{contractStatusLabel}</div>

                                    {gameContract?.contractAddress && (

                                        <div className="page4__contractAddress">

                                            {gameContract.contractAddress}

                                        </div>

                                    )}

                                </div>

                            )}

                            {localPaymentRequest?.requiredGram != null
                                && canConfirm && (

                                <div className="smartContractStatus">

                                    {`Pay ${localPaymentRequest.requiredGram} GRM`}

                                </div>

                            )}

                            {paymentSession?.status === "COMPLETED" ? (

                                <div className="smartContractStatus">

                                    All payments confirmed

                                </div>

                            ) : paymentSession?.status === "FAILED"
                                || gameContract?.status === "DEPLOY_FAILED" ? (

                    <div className="smartContractStatus">

                                    {gameContract?.status === "DEPLOY_FAILED"
                                        ? "Deployment failed"
                                        : "Payment session failed"}

                                </div>

                            ) : (

                                <>

                                    <button
                                        type="button"
                                        className="page4__connectButton"
                                        disabled={!canConfirm || confirmingPayment}
                                        onClick={handleConfirmPayment}
                                    >

                                        {confirmingPayment
                                            ? "OPENING WALLET…"
                                            : "CONFIRM IN TELEGRAM WALLET"}

                                    </button>

                                    <button
                                        type="button"
                                        className="page4__disconnectButton"
                                        disabled={!canConfirm || confirmingPayment}
                                        onClick={handleCancelPayment}
                                    >

                                        CANCEL

                                    </button>

                                </>

                            )}

                        </div>

                    ) : (

                        <div className="page4__connectActions">

                            <button
                                type="button"
                                className="page4__connectButton"
                                disabled={!canConnect}
                                onClick={handleConnectWallet}
                            >

                                CONNECT TELEGRAM WALLET

                            </button>

                            {(
                                localWalletStatus === WALLET_CONNECTION_STATUS.CONNECTED
                                || localWalletStatus === WALLET_CONNECTION_STATUS.ADDRESS_MISMATCH
                                || Boolean(tonWallet)
                            ) && (

                                <button
                                    type="button"
                                    className="page4__disconnectButton"
                                    onClick={handleDisconnectWallet}
                                >

                                    DISCONNECT

                                </button>

                            )}

                    </div>

                    )}

                </div>

            </div>

        </GameLayout>

    );

}
