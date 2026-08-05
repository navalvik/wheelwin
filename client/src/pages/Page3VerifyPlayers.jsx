import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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

/**
 * R7.30 — SPA-lifetime emit guard (survives StrictMode remount / effect replay).
 * Keyed by roomId + playerId so reconnect replay cannot double-fire VERIFY_NEXT.
 */
const verifyNextEmittedSeats = new Set();

function verifyNextSeatKey(roomId, playerId) {

    if (roomId == null || playerId == null || playerId === "") {

        return null;

    }

    return `${String(roomId)}::${String(playerId)}`;

}

function clearVerifyNextSeat(roomId, playerId) {

    const key = verifyNextSeatKey(roomId, playerId);

    if (key) {

        verifyNextEmittedSeats.delete(key);

    }

}

/** R7.30 — decision traces (browser console → Developer Log capture). */
function verifyDecisionTrace(step, detail = {}) {

    console.info(`[VERIFY TRACE] ${step}`, {
        at: Date.now(),
        step,
        ...detail
    });

}

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

    const roomId = authoritative.roomId ?? null;

    // Prefer roster seat; fall back to identity (server binds by socket either way).
    const emitPlayerId = localPlayerId ?? identity.playerId ?? null;

    const emitSeatKey = verifyNextSeatKey(roomId, emitPlayerId);

    const autoVerifyNextInFlightRef = useRef(false);

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

            // Allow a single retry after server rejection (invalid wallet).
            clearVerifyNextSeat(roomId, emitPlayerId);

            autoVerifyNextInFlightRef.current = false;

            setWaitingForPaymentStage(false);

            setWalletError(
                typeof payload?.message === "string" && payload.message
                    ? payload.message
                    : "Invalid TON wallet address."
            );

        }

        socket.on("WALLET_REJECTED", handleWalletRejected);

        return () => {

            socket.off("WALLET_REJECTED", handleWalletRejected);

        };

    }, [roomId, emitPlayerId]);

    /**
     * R7.30 — sole VERIFY_NEXT_REQUEST emitter (auto path).
     * Protocol unchanged; trigger is automatic after VERIFY_COMPLETED.
     */
    const emitVerifyNextRequest = useCallback((source) => {

        const seatKey = verifyNextSeatKey(roomId, emitPlayerId);

        if (seatKey && verifyNextEmittedSeats.has(seatKey)) {

            verifyDecisionTrace("AUTO_VERIFY_NEXT_SKIP_ALREADY_SENT", {
                source,
                roomId,
                playerId: emitPlayerId,
                seatKey
            });

            if (!waitingForPaymentStage && !paymentStageReady) {

                setWaitingForPaymentStage(true);

            }

            return false;

        }

        if (!verifyCompleted
            || waitingForVerify
            || waitingForPaymentStage
            || paymentStageReady) {

            verifyDecisionTrace("AUTO_VERIFY_NEXT_SKIP_NOT_READY", {
                source,
                roomId,
                playerId: emitPlayerId,
                verifyCompleted,
                waitingForVerify,
                waitingForPaymentStage,
                paymentStageReady
            });

            return false;

        }

        if (!isWalletValid) {

            verifyDecisionTrace("AUTO_VERIFY_NEXT_SKIP_INVALID_WALLET", {
                source,
                roomId,
                playerId: emitPlayerId
            });

            return false;

        }

        if (!seatKey) {

            verifyDecisionTrace("AUTO_VERIFY_NEXT_SKIP_NOT_READY", {
                source,
                roomId,
                playerId: emitPlayerId,
                reason: "missing_seat_key"
            });

            return false;

        }

        if (autoVerifyNextInFlightRef.current) {

            verifyDecisionTrace("AUTO_VERIFY_NEXT_SKIP_ALREADY_SENT", {
                source,
                roomId,
                playerId: emitPlayerId,
                reason: "in_flight"
            });

            return false;

        }

        autoVerifyNextInFlightRef.current = true;

        verifyNextEmittedSeats.add(seatKey);

        setWalletError("");

        setWaitingForPaymentStage(true);

        verifyDecisionTrace("AUTO_VERIFY_NEXT_EMIT", {
            source,
            roomId,
            playerId: emitPlayerId,
            seatKey
        });

        socket.emit("VERIFY_NEXT_REQUEST", {
            roomId,
            playerId: emitPlayerId,
            walletAddress: walletAddress.trim()
        });

        return true;

    }, [
        roomId,
        emitPlayerId,
        verifyCompleted,
        waitingForVerify,
        waitingForPaymentStage,
        paymentStageReady,
        isWalletValid,
        walletAddress
    ]);

    // R7.30 — automatic VERIFY continuation after VERIFY_COMPLETED.
    useEffect(() => {

        if (!verifyCompleted) {

            return;

        }

        if (paymentStageReady) {

            return;

        }

        if (emitSeatKey && verifyNextEmittedSeats.has(emitSeatKey)) {

            verifyDecisionTrace("AUTO_VERIFY_NEXT_SKIP_ALREADY_SENT", {
                source: "auto_effect",
                roomId,
                playerId: emitPlayerId,
                seatKey: emitSeatKey
            });

            if (!waitingForPaymentStage) {

                setWaitingForPaymentStage(true);

            }

            return;

        }

        if (waitingForVerify || waitingForPaymentStage) {

            verifyDecisionTrace("AUTO_VERIFY_NEXT_SKIP_NOT_READY", {
                source: "auto_effect",
                roomId,
                playerId: emitPlayerId,
                waitingForVerify,
                waitingForPaymentStage
            });

            return;

        }

        if (!isWalletValid) {

            verifyDecisionTrace("AUTO_VERIFY_NEXT_SKIP_INVALID_WALLET", {
                source: "auto_effect",
                roomId,
                playerId: emitPlayerId
            });

            return;

        }

        verifyDecisionTrace("AUTO_VERIFY_NEXT_READY", {
            source: "auto_effect",
            roomId,
            playerId: emitPlayerId
        });

        emitVerifyNextRequest("auto_effect");

    }, [
        verifyCompleted,
        paymentStageReady,
        waitingForVerify,
        waitingForPaymentStage,
        isWalletValid,
        walletAddress,
        emitSeatKey,
        roomId,
        emitPlayerId,
        emitVerifyNextRequest
    ]);

    function handleConfirmVerify() {

        if (!isWalletValid || waitingForVerify || verifyCompleted) {

            return;

        }

        setWaitingForVerify(true);

        setWalletError("");

        socket.emit("confirmVerify");

    }

    function handleNext() {

        if (!isWalletValid) {

            setWalletError(
                "Invalid TON wallet address."
            );

            return;

        }

        // R7.30 — after VERIFY_COMPLETED, continuation is automatic.
        // Manual NEXT is only for barrier #1 (confirmVerify).
        if (verifyCompleted) {

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
                paymentStageReady || verifyCompleted
                    ? false
                    : (isWalletValid && !waitingForVerify)
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
                                : isWalletValid
                                    ? "Players verified. Continuing to payment…"
                                    : "Players verified. Enter a valid wallet to continue."}

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

                                // P6.1 / R7.30 — editing before freeze allows one
                                // corrected auto VERIFY_NEXT after rejection/edit.
                                if (!paymentStageReady) {

                                    clearVerifyNextSeat(roomId, emitPlayerId);

                                    autoVerifyNextInFlightRef.current = false;

                                    if (waitingForPaymentStage) {

                                        setWaitingForPaymentStage(false);

                                    }

                                }

                            }}
                        />

                    </div>

                </div>

            </div>

        </GameLayout>

    );

}
