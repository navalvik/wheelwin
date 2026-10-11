import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import GameLayout from "../layouts/GameLayout";

import { useAuthoritativeSession } from "../context/AuthoritativeSessionContext";
import { useLanguage } from "../context/LanguageContext";
import { usePlayerIdentity } from "../context/PlayerIdentityContext";

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

    const verifyCompleted = authoritative.lifecycle?.verifyCompleted === true;

    const localPlayerId = resolveLocalPlayerId(
        identity.playerId ?? null,
        authoritative.players,
        { verifyCompleted }
    );

    const [waitingForVerify, setWaitingForVerify] = useState(false);

    const [waitingForContinue, setWaitingForContinue] = useState(false);

    const playersReady = hasAuthoritativePlayers(authoritative.players);

    const players = useMemo(
        () => listAuthoritativePlayers(authoritative.players)
            .map((player, index) => mapAuthoritativePlayerToInfoProp(
                player,
                index,
                {
                    localPlayerId
                }
            )),
        [authoritative.players, localPlayerId]
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

        if (waitingForVerify || verifyCompleted) {

            return;

        }

        setWaitingForVerify(true);

        socket.emit("confirmVerify");

    }

    function handleNext() {
return (

        <GameLayout

            message={t("page.verify.title")}

            backEnabled={!waitingForVerify && !verifyCompleted}

            onBack={() => onNavigate(4)}

            nextEnabled={
                verifyCompleted
                    ? false
                    : !waitingForVerify
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

        // R7.30 — after VERIFY_COMPLETED, continuation is automatic.
        // Manual NEXT is only for barrier #1 (confirmVerify).
        if (verifyCompleted) {

            return;

        }

        handleConfirmVerify();

    }