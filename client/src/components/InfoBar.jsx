import { useEffect, useState } from "react";

import { useAuthoritativeSession } from "../context/AuthoritativeSessionContext";
import { useGameSession } from "../context/GameSessionContext";

import {
    formatAuthoritativeRoomId,
    formatAuthoritativeRoomPlayersDisplay,
    getAuthoritativeRoom
} from "../game/session";

import { isGameplayPage } from "../game/sessionRecovery/recoveryFlow";

import "../styles/infoBar.css";

function remainingSecondsFromExpiresAt(expiresAt) {

    if (!Number.isFinite(expiresAt)) {

        return null;

    }

    return Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));

}

export default function InfoBar() {

    const {
        session,
        currentPage,
        phaseTimerLabel,
        formatPhaseTime
    } = useGameSession();

    // C5.4 — room metadata (id + player capacity display) comes from
    // AuthoritativeSession. C5.6C — Setup Timer from AuthoritativeSession.setup.
    // R1.3C — Gameplay Timer (Timer 2) from AuthoritativeSession.gameplayTimer.
    const authoritative = useAuthoritativeSession();

    const room = getAuthoritativeRoom(authoritative);

    const [, setTick] = useState(0);

    // InfoBar is only a router between two independent time domains. Selection is
    // page-based: gameplay/result pages present Timer 2 (Gameplay Timer);
    // every preparation page presents the Setup Session timer.
    const useGameplayTimer = isGameplayPage(currentPage);

    const activeExpiresAt = useGameplayTimer
        ? authoritative.gameplayTimer?.expiresAt
        : authoritative.setup?.expiresAt;

    useEffect(() => {

        if (!activeExpiresAt) {

            return undefined;

        }

        const timerId = setInterval(() => {

            setTick((value) => value + 1);

        }, 1000);

        return () => clearInterval(timerId);

    }, [activeExpiresAt]);

    const roomIdDisplay = formatAuthoritativeRoomId(room.roomId) ?? "—";

    const playersDisplay = formatAuthoritativeRoomPlayersDisplay(
        authoritative.players,
        room.maxPlayers,
        session.maxPlayers
    ) ?? "—";

    const setupRemaining = remainingSecondsFromExpiresAt(
        authoritative.setup?.expiresAt
    );

    const gameplayRemaining = remainingSecondsFromExpiresAt(
        authoritative.gameplayTimer?.expiresAt
    );

    const timerLabel = useGameplayTimer
        ? "GAMEPLAY TIMER"
        : phaseTimerLabel;

    const timerValue = useGameplayTimer
        ? (gameplayRemaining === null
            ? "--"
            : formatPhaseTime(gameplayRemaining))
        : (setupRemaining === null
            ? "—"
            : formatPhaseTime(setupRemaining));

    return (

        <div className="infoBar">

            <div className="infoBarSection">

                <div className="infoBarTitle">

                    ROOM ID

                </div>

                <div className="infoBarValue">

                    {roomIdDisplay}

                </div>

            </div>

            <div className="infoBarSection">

                <div className="infoBarTitle">

                    PLAYERS

                </div>

                <div className="infoBarValue">

                    {playersDisplay}

                </div>

            </div>

            <div className="infoBarSection">

                <div className="infoBarTitle">

                    {timerLabel}

                </div>

                <div className="infoBarValue">

                    {timerValue}

                </div>

            </div>

        </div>

    );

}
