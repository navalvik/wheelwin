import { useEffect, useMemo, useState } from "react";

import GameLayout from "../layouts/GameLayout";

import PlayerInfoRow from "../components/PlayerInfoRow";

import { useAuthoritativeSession } from "../context/AuthoritativeSessionContext";
import { useGameSession } from "../context/GameSessionContext";
import { useLanguage } from "../context/LanguageContext";
import { usePlayerIdentity } from "../context/PlayerIdentityContext";

import {
    getAuthoritativePlayerSectorCount,
    hasAuthoritativePlayers,
    listAuthoritativePlayers,
    mapAuthoritativePlayerToInfoProp,
    resolveLocalPlayerId
} from "../game/session";

import { calculatePaymentGram } from "../utils/playerProfileRules";

import {
    isValidTelegramWallet
} from "../utils/telegramWalletRules";

import socket from "../socket/socket";

import "../styles/page3verify.css";

export default function Page3VerifyPlayers({ onNavigate }) {

    // AuthoritativeSession.players → lookup by playerId → nickname / sectorCount /
    // payment for highlight + footer. Never by array order.
    const authoritative = useAuthoritativeSession();

    const { session } = useGameSession();

    const { t } = useLanguage();

    const { identity } = usePlayerIdentity();

    const verifyCompleted = authoritative.lifecycle?.verifyCompleted === true;

    const paymentStageReady = authoritative.lifecycle?.paymentStageReady === true;

    const localPlayerId = resolveLocalPlayerId(
        identity.playerId ?? null,
        authoritative.players,
        { verifyCompleted }
    );

    const localAuthoritativePlayer = localPlayerId
        ? (authoritative.players[localPlayerId] ?? null)
        : null;

    // P6.1 — session wallet ack only (never localStorage / permanent identity).
    const authoritativeWallet = typeof localAuthoritativePlayer?.wallet === "string"
        ? localAuthoritativePlayer.wallet
        : "";

    const [walletAddress, setWalletAddress] = useState("");

    const [waitingForVerify, setWaitingForVerify] = useState(false);

    const [waitingForPaymentStage, setWaitingForPaymentStage] = useState(false);

    const [walletError, setWalletError] = useState("");

    const isWalletValid = isValidTelegramWallet(walletAddress);

    // P6.1 — locked only after server freezes setup (PAYMENT_STAGE_READY).
    const walletLocked = paymentStageReady;

    const playersReady = hasAuthoritativePlayers(authoritative.players);

    const players = useMemo(
        () => listAuthoritativePlayers(authoritative.players)
            .map((player, index) => mapAuthoritativePlayerToInfoProp(
                player,
                index,
                {
                    localPlayerId,
                    baseStake: session.baseStake
                }
            )),
        [authoritative.players, localPlayerId, session.baseStake]
    );

    // Footer YOU NEED PAY — from the authoritative local player record only.
    const youNeedPay = calculatePaymentGram(
        session.baseStake,
        getAuthoritativePlayerSectorCount(localAuthoritativePlayer)
    );

    useEffect(() => {

        if (verifyCompleted) {

            setWaitingForVerify(false);

        }

    }, [verifyCompleted]);

    // Reconnect / private ack: restore authoritative wallet into the input.
    useEffect(() => {

        if (!authoritativeWallet) {

            return;

        }

        setWalletAddress((current) => (
            current.trim() === authoritativeWallet
                ? current
                : authoritativeWallet
        ));

    }, [authoritativeWallet]);

    useEffect(() => {

        if (!paymentStageReady) {

            return;

        }

        setWaitingForPaymentStage(false);

        setWalletError("");

        onNavigate(6);

    }, [paymentStageReady, onNavigate]);

    useEffect(() => {

        function handleWalletRejected(payload) {

            setWaitingForPaymentStage(false);

            setWalletError(
                typeof payload?.message === "string" && payload.message
                    ? payload.message
                    : "Enter a valid Telegram Wallet address starting with EQ."
            );

        }

        socket.on("WALLET_REJECTED", handleWalletRejected);

        return () => {

            socket.off("WALLET_REJECTED", handleWalletRejected);

        };

    }, []);

    function handleConfirmVerify() {

        if (!isWalletValid || waitingForVerify || verifyCompleted) {

            return;

        }

        setWaitingForVerify(true);

        setWalletError("");

        socket.emit("confirmVerify");

    }

    function handleVerifyNextRequest() {

        if (
            !verifyCompleted
            || !isWalletValid
            || waitingForPaymentStage
            || paymentStageReady
        ) {

            return;

        }

        setWalletError("");

        setWaitingForPaymentStage(true);

        socket.emit("VERIFY_NEXT_REQUEST", {
            roomId: authoritative.roomId ?? null,
            playerId: localPlayerId,
            walletAddress: walletAddress.trim()
        });

    }

    function handleNext() {

        if (!isWalletValid) {

            setWalletError(
                "Enter a valid Telegram Wallet address starting with EQ."
            );

            return;

        }

        if (verifyCompleted) {

            handleVerifyNextRequest();

            return;

        }

        handleConfirmVerify();

    }

    return (

        <GameLayout

            message={t("page.verify.title")}

            backEnabled={!waitingForVerify && !verifyCompleted}

            onBack={() => onNavigate(4)}

            nextEnabled={
                paymentStageReady
                    ? false
                    : (
                        verifyCompleted
                            ? (isWalletValid && !waitingForPaymentStage)
                            : (isWalletValid && !waitingForVerify)
                    )
            }

            onNext={handleNext}

        >

            <div className="page3">

                <div className="verifyPanel">

                    <div className="verifyPlayers">

                        {playersReady ? (

                            players.map((player) => (

                                <PlayerInfoRow

                                    key={player.key}

                                    labelTitle={player.labelTitle}

                                    nickname={player.nickname}

                                    icon={player.icon}

                                    age={player.age}

                                    sectorLabel={player.sectorLabel}

                                    sectorValue={player.sectorValue}

                                    paymentLabel={player.paymentLabel}

                                    paymentDisplay={player.paymentDisplay}

                                    isLocal={player.isLocal}

                                />

                            ))

                        ) : (

                            <div
                                className="verifyPlayersWaiting"
                                aria-live="polite"
                            >

                                Waiting for players…

                            </div>

                        )}

                    </div>

                    {waitingForVerify && !verifyCompleted && (

                        <div
                            className="verifyPlayersWaiting"
                            aria-live="polite"
                        >

                            Waiting for all players to confirm…

                        </div>

                    )}

                    {verifyCompleted && !paymentStageReady && (

                        <div
                            className="verifyPlayersWaiting"
                            aria-live="polite"
                        >

                            {waitingForPaymentStage
                                ? "Waiting for all players to continue…"
                                : "Players verified. Continue to payment."}

                        </div>

                    )}

                    {walletError && (

                        <div
                            className="verifyPlayersWaiting"
                            aria-live="assertive"
                        >

                            {walletError}

                        </div>

                    )}

                    <div className="verifyFinanceRow">

                        <div className="verifyFinanceGroup">

                            <span className="verifyFinanceLabel">

                                BASE STAKE

                            </span>

                            <span className="verifyFinanceValue">

                                {session.baseStake}

                            </span>

                        </div>

                        <div className="verifyFinanceGroup">

                            <span className="verifyFinanceLabel">

                                YOU NEED PAY GRAM

                            </span>

                            <span className="verifyFinanceValue">

                                {youNeedPay}

                            </span>

                        </div>

                    </div>

                    <div className="verifyWallet">

                        <label
                            className="verifyWalletLabel"
                            htmlFor="verifyWalletAddress"
                        >

                            ENTER YOUR GRAM (TON) TELEGRAM WALLET ADDRESS

                        </label>

                        <input
                            id="verifyWalletAddress"
                            className="verifyWalletInput"
                            type="text"
                            value={walletAddress}
                            disabled={walletLocked}
                            onChange={(e) => {

                                setWalletError("");

                                setWalletAddress(e.target.value);

                                // P6.1 — editing before freeze unlocks another NEXT submit.
                                if (waitingForPaymentStage && !paymentStageReady) {

                                    setWaitingForPaymentStage(false);

                                }

                            }}
                        />

                    </div>

                </div>

            </div>

        </GameLayout>

    );

}
