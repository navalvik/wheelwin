import { useCallback, useEffect, useMemo, useState } from "react";

import { useTonConnectUI, useTonWallet } from "@tonconnect/ui-react";

import GameLayout from "../layouts/GameLayout";

import PlayerPaymentRow from "../components/PlayerPaymentRow";

import { useAuthoritativeSession } from "../context/AuthoritativeSessionContext";
import { useLanguage } from "../context/LanguageContext";
import { usePlayerIdentity } from "../context/PlayerIdentityContext";

import {
    canConfirmLocalPayment,
    hasPaymentSession,
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
    // OPEN_PAGE5 remains server-owned for a later stage.
    const authoritative = useAuthoritativeSession();

    const { t } = useLanguage();

    const { identity } = usePlayerIdentity();

    const [tonConnectUI] = useTonConnectUI();

    const tonWallet = useTonWallet();

    const [localError, setLocalError] = useState("");

    const [connecting, setConnecting] = useState(false);

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

    const canConfirm = canConfirmLocalPayment(paymentSession, localPlayerId);

    const reportConnectedWallet = useCallback((rawAddress) => {

        const connectedWallet = toSessionWalletAddress(rawAddress);

        if (!connectedWallet) {

            setLocalError(
                "Connected wallet does not match the wallet entered during VERIFY."
            );

            return;

        }

        socket.emit(LOBBY_OUTGOING_EVENTS.WALLET_CONNECT_REPORT, {
            roomId: authoritative.roomId ?? null,
            playerId: localPlayerId,
            connectedWallet
        });

    }, [authoritative.roomId, localPlayerId]);

    useEffect(() => {

        if (!tonWallet?.account?.address) {

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

                    socket.emit(LOBBY_OUTGOING_EVENTS.WALLET_DISCONNECT_REPORT);

                }

            }

        });

        return () => {

            unsubscribe?.();

        };

    }, [tonConnectUI, localWalletStatus]);

    async function handleConnectWallet() {

        if (!canConnect) {

            return;

        }

        setLocalError("");

        setConnecting(true);

        socket.emit(LOBBY_OUTGOING_EVENTS.WALLET_CONNECT_STARTED);

        try {

            await tonConnectUI.openModal();

        } catch {

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

    function handleConfirmPayment() {

        if (!canConfirm) {

            return;

        }

        socket.emit(LOBBY_OUTGOING_EVENTS.PAYMENT_CONFIRM_INTENT);

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

                            {contractStatusLabel && (

                                <div
                                    className="smartContractStatus"
                                    aria-live="polite"
                                >

                                    <div>Game Contract</div>

                                    <div>{contractStatusLabel}</div>

                                </div>

                            )}

                            {paymentSession?.status === "COMPLETED" ? (

                                <div className="smartContractStatus">

                                    All payments confirmed

                                </div>

                            ) : paymentSession?.status === "FAILED" ? (

                                <div className="smartContractStatus">

                                    Payment session failed

                                </div>

                            ) : (

                                <button
                                    type="button"
                                    className="page4__connectButton"
                                    disabled={!canConfirm}
                                    onClick={handleConfirmPayment}
                                >

                                    CONFIRM PAYMENT

                                </button>

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
