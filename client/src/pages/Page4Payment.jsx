import { useCallback, useEffect, useMemo, useState } from "react";

import { useTonConnectUI, useTonWallet } from "@tonconnect/ui-react";

import GameLayout from "../layouts/GameLayout";

import PlayerPaymentRow from "../components/PlayerPaymentRow";

import { useAuthoritativeSession } from "../context/AuthoritativeSessionContext";
import { useLanguage } from "../context/LanguageContext";
import { usePlayerIdentity } from "../context/PlayerIdentityContext";

import {
    mapWalletConnectionRows,
    shouldShowWalletConnectionWaiting,
    WALLET_CONNECTION_STATUS
} from "../game/session";

import { resolveLocalPlayerId } from "../game/session";

import { toSessionWalletAddress } from "../utils/tonWalletAddress";

import socket from "../socket/socket";

import { LOBBY_OUTGOING_EVENTS } from "../socket/socketEvents";

import "../styles/page4payment.css";

export default function Page4Payment({ onNavigate }) {

    // P6.2 — Page4 mirrors AuthoritativeSession.walletConnection.
    // OPEN_PAGE5 remains server-owned for a later payment stage.
    const authoritative = useAuthoritativeSession();

    const { t } = useLanguage();

    const { identity } = usePlayerIdentity();

    const [tonConnectUI] = useTonConnectUI();

    const tonWallet = useTonWallet();

    const [localError, setLocalError] = useState("");

    const [connecting, setConnecting] = useState(false);

    const walletConnection = authoritative.walletConnection;

    const paymentConnectionReady = authoritative.lifecycle
        ?.paymentConnectionReady === true;

    const waiting = shouldShowWalletConnectionWaiting(walletConnection);

    const localPlayerId = resolveLocalPlayerId(
        identity.playerId ?? null,
        authoritative.players,
        {
            verifyCompleted: Boolean(authoritative.lifecycle?.verifyCompleted)
        }
    );

    const players = useMemo(
        () => mapWalletConnectionRows(
            walletConnection,
            authoritative.players
        ),
        [walletConnection, authoritative.players]
    );

    const localSeat = useMemo(
        () => players.find(
            (player) => String(player.playerId) === String(localPlayerId)
        ) ?? null,
        [players, localPlayerId]
    );

    const localStatus = localSeat?.status ?? WALLET_CONNECTION_STATUS.WAITING;

    const canConnect = !paymentConnectionReady
        && localStatus !== WALLET_CONNECTION_STATUS.CONNECTED
        && localStatus !== WALLET_CONNECTION_STATUS.CONNECTING
        && !connecting;

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

        if (localStatus === WALLET_CONNECTION_STATUS.ADDRESS_MISMATCH) {

            setLocalError(
                "Connected wallet does not match the wallet entered during VERIFY."
            );

            return;

        }

        if (localStatus === WALLET_CONNECTION_STATUS.CONNECTED) {

            setLocalError("");

        }

    }, [localStatus]);

    useEffect(() => {

        const unsubscribe = tonConnectUI.onModalStateChange((state) => {

            if (state?.status === "closed" && !tonConnectUI.wallet) {

                setConnecting(false);

                if (localStatus === WALLET_CONNECTION_STATUS.CONNECTING) {

                    socket.emit(LOBBY_OUTGOING_EVENTS.WALLET_DISCONNECT_REPORT);

                }

            }

        });

        return () => {

            unsubscribe?.();

        };

    }, [tonConnectUI, localStatus]);

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

    return (

        <GameLayout

            message={t("page.payment.title")}

            backEnabled={!paymentConnectionReady}

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

                                Waiting for payment...

                            </div>

                        ) : (

                            players.map((player) => (

                                <PlayerPaymentRow

                                    key={player.key}

                                    labelTitle={player.labelTitle}

                                    nickname={player.nickname}

                                    icon={player.icon}

                                    connectionStatus={player.status}

                                    connectionStatusLabel={player.statusLabel}

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

                    {paymentConnectionReady ? (

                        <div className="smartContractStatus">

                            All wallets connected

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
                                localStatus === WALLET_CONNECTION_STATUS.CONNECTED
                                || localStatus === WALLET_CONNECTION_STATUS.ADDRESS_MISMATCH
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
