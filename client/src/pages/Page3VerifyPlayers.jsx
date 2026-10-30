import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import GameLayout from "../layouts/GameLayout";

import { useAuthoritativeSession } from "../context/AuthoritativeSessionContext";
import { useLanguage } from "../context/LanguageContext";
import { usePlayerIdentity } from "../context/PlayerIdentityContext";
import { useGameSession } from "../context/GameSessionContext";

import {
    hasAuthoritativePlayers,
    listAuthoritativePlayers,
    mapAuthoritativePlayerToInfoProp,
    resolveLocalPlayerId
} from "../game/session";

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

    // AuthoritativeSession.players → lookup by playerId → nickname / sectorCount
    // for the roster. Never by array order.
    const authoritative = useAuthoritativeSession();

    const { t } = useLanguage();

    const { identity } = usePlayerIdentity();

    const gameSession = useGameSession();

    const verifyCompleted = authoritative.lifecycle?.verifyCompleted === true;

    const localPlayerId = resolveLocalPlayerId(
        identity.playerId ?? null,
        authoritative.players,
        { verifyCompleted }
    );

    const [waitingForVerify, setWaitingForVerify] = useState(identity?.verifyConfirmed === true);

    const [payerWalletAddress, setPayerWalletAddress] = useState(identity?.wallet ?? "");

    const payerWalletValid = /^(?:0:[0-9a-fA-F]{64}|[A-Za-z0-9_-]{48})$/.test(payerWalletAddress.trim());

    const [waitingForContinue, setWaitingForContinue] = useState(identity?.verifyContinued === true);

    const playersReady = hasAuthoritativePlayers(authoritative.players);

    const players = useMemo(
        () => listAuthoritativePlayers(authoritative.players)
            .map((player, index) => mapAuthoritativePlayerToInfoProp(
                player,
                index,
                {
                    localPlayerId,
                    baseStake: gameSession.baseStake
                }
            )),
        [authoritative.players, localPlayerId, gameSession.baseStake]
    );

    const roomId = authoritative.roomId ?? null;

    // Prefer roster seat; fall back to identity (server binds by socket either way).
    const emitPlayerId = localPlayerId ?? identity.playerId ?? null;

    const emitSeatKey = verifyNextSeatKey(roomId, emitPlayerId);

    const autoVerifyNextInFlightRef = useRef(false);

    useEffect(() => {
        if (identity?.verifyContinued && emitSeatKey) {
            verifyNextEmittedSeats.add(emitSeatKey);
        }
    }, [identity?.verifyContinued, emitSeatKey]);

    useEffect(() => {
        const onRoomRecoverySync = (payload) => {
            if (!payload?.playerId || payload.playerId !== identity?.playerId) return;
            if (payload.profile?.wallet) {
                setPayerWalletAddress(payload.profile.wallet);
            }
            if (payload.verifyConfirmed) setWaitingForVerify(true);
            if (payload.verifyContinued) {
                const seatKey = verifyNextSeatKey(payload.roomId, payload.playerId);
                if (seatKey) verifyNextEmittedSeats.add(seatKey);
                setWaitingForContinue(true);
            }
        };
        socket.on("ROOM_RECOVERY_SYNC", onRoomRecoverySync);
        return () => socket.off("ROOM_RECOVERY_SYNC", onRoomRecoverySync);
    }, [identity?.playerId]);

    useEffect(() => {

        if (verifyCompleted) {

            setWaitingForVerify(false);

        }

    }, [verifyCompleted]);
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

            if (!waitingForContinue) {

                setWaitingForContinue(true);

            }

            return false;

        }

        if (!verifyCompleted || waitingForVerify || waitingForContinue) {

            verifyDecisionTrace("AUTO_VERIFY_NEXT_SKIP_NOT_READY", {
                source,
                roomId,
                playerId: emitPlayerId,
                verifyCompleted,
                waitingForVerify,
                waitingForContinue
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

        setWaitingForContinue(true);

        verifyDecisionTrace("AUTO_VERIFY_NEXT_EMIT", {
            source,
            roomId,
            playerId: emitPlayerId,
            seatKey
        });

        socket.emit("VERIFY_NEXT_REQUEST", {
            roomId,
            playerId: emitPlayerId
        });

        return true;

    }, [
        roomId,
        emitPlayerId,
        verifyCompleted,
        waitingForVerify,
        waitingForContinue
    ]);
// R7.30 — automatic VERIFY continuation after VERIFY_COMPLETED.
    useEffect(() => {

        if (!verifyCompleted) {

            return;

        }

        if (emitSeatKey && verifyNextEmittedSeats.has(emitSeatKey)) {

            verifyDecisionTrace("AUTO_VERIFY_NEXT_SKIP_ALREADY_SENT", {
                source: "auto_effect",
                roomId,
                playerId: emitPlayerId,
                seatKey: emitSeatKey
            });

            if (!waitingForContinue) {

                setWaitingForContinue(true);

            }

            return;

        }

        if (waitingForVerify || waitingForContinue) {

            verifyDecisionTrace("AUTO_VERIFY_NEXT_SKIP_NOT_READY", {
                source: "auto_effect",
                roomId,
                playerId: emitPlayerId,
                waitingForVerify,
                waitingForContinue
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
        waitingForVerify,
        waitingForContinue,
        emitSeatKey,
        roomId,
        emitPlayerId,
        emitVerifyNextRequest
    ]);

    function handleConfirmVerify() {

        if (waitingForVerify || verifyCompleted || !payerWalletValid) {

            return;

        }

        // Same authoritative socket: send wallet identity before VERIFY.
        // No amount, room wallet, payment reference or confirmation is supplied.
        socket.emit("updatePlayerProfile", {
            wallet: payerWalletAddress.trim()
        });

        setWaitingForVerify(true);

        socket.emit("confirmVerify");

    }

    function handleNext() {

        // Manual NEXT confirms this player's wallet identity. The server then
        // coordinates the verification barrier and advances the room.
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
                verifyCompleted
                    ? false
                    : !waitingForVerify && payerWalletValid
            }

            onNext={handleNext}

        >

            <div className="page3">

                <div className="verifyPanel">

                    <div className="verifyPlayers">

                        {playersReady ? (

                            players.map((player) => (

                                <div
                                    key={player.key}
                                    className={
                                        player.isLocal
                                            ? "verifyPlayerCard verifyPlayerCard--local"
                                            : "verifyPlayerCard"
                                    }
                                >

                                    <div className="verifyPlayerTitle">
                                        {player.isLocal
                                            ? `${player.labelTitle?.replace?.(/\\s*—\\s*YOU$/i, "") || player.labelTitle} — YOU`
                                            : player.labelTitle}
                                    </div>

                                    <div className="verifyPlayerNickname">
                                        {player.nickname}
                                    </div>

                                    <div className="verifyPlayerIcon" aria-hidden="true">
                                        {player.icon}
                                    </div>

                                    <div className="verifyPlayerStat">
                                        <span>{t("player.age")}</span>
                                        <strong>{player.age}</strong>
                                    </div>

                                    <div className="verifyPlayerStat">
                                        <span>{t("player.sector")}</span>
                                        <strong>{player.sectorValue}</strong>
                                    </div>

                                </div>

                            ))

                        ) : (

                            <div
                                className="verifyPlayersWaiting"
                                aria-live="polite"
                            >

                                {t("verify.waitingForPlayers")}

                            </div>

                        )}

                    </div>

                    {playersReady && (

                        <div className="verifyFinanceRow">

                            <div className="verifyFinanceGroup">
                                <span className="verifyFinanceLabel">BASE STAKE</span>
                                <strong className="verifyFinanceValue">
                                    {gameSession.baseStake > 0 ? gameSession.baseStake : "—"}
                                </strong>
                            </div>

                            <div className="verifyFinanceGroup">
                                <span className="verifyFinanceLabel">YOU NEED PAY GRAM</span>
                                <strong className="verifyFinanceValue">
                                    {players.find((player) => player.isLocal)?.paymentDisplay ?? "—"}
                                </strong>
                            </div>

                        </div>

                    )}

                    <div className="verifyWallet">
                        <label className="verifyWalletLabel" htmlFor="page3-testnet-wallet">
                            ENTER YOUR GRAM (TON) TELEGRAM WALLET ADDRESS
                        </label>
                        <input
                            className="verifyWalletInput"
                            id="page3-testnet-wallet"
                            type="text"
                            inputMode="text"
                            autoComplete="off"
                            spellCheck={false}
                            value={payerWalletAddress}
                            onChange={(event) => setPayerWalletAddress(event.target.value)}
                            disabled={waitingForVerify || verifyCompleted}
                            maxLength={66}
                            aria-invalid={payerWalletAddress.length > 0 && !payerWalletValid}
                            placeholder="0Q... or UQ..."
                        />
                        {!payerWalletValid && (
                            <p>Enter your own Testnet wallet address before VERIFY.</p>
                        )}
                    </div>

                    {waitingForVerify && !verifyCompleted && (

                        <div
                            className="verifyPlayersWaiting"
                            aria-live="polite"
                        >

                            {t("verify.waitingConfirm")}

                        </div>

                    )}

                    {verifyCompleted && (

                        <div
                            className="verifyPlayersWaiting"
                            aria-live="polite"
                        >

                            {t("verify.waitingContinue")}

                        </div>

                    )}

                </div>

            </div>

        </GameLayout>

    );

}
