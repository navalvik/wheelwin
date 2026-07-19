import { useEffect, useState } from "react";

import { useAuthoritativeSession } from "../context/AuthoritativeSessionContext";
import { useGameSession } from "../context/GameSessionContext";
import { useGameClock } from "../context/GameClockContext";

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

    // C5.4 — room metadata from AuthoritativeSession.
    // C5.6C — Setup Timer from AuthoritativeSession.setup.
    // R1.3C — Gameplay Timer (Timer 2) from AuthoritativeSession.gameplayTimer.
    const authoritative = useAuthoritativeSession();

    const room = getAuthoritativeRoom(authoritative);

    const { phaseLabel } = useGameClock();

    const [, setTick] = useState(0);

    const useGameplayClock = isGameplayPage(currentPage);

    const activeExpiresAt = useGameplayClock
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

    // Page5+: Timer 2 wall clock. Prep pages: Setup Timer.
    // GameClock phase label remains informational via phaseLabel when present.
    const setupRemaining = remainingSecondsFromExpiresAt(
        authoritative.setup?.expiresAt
    );

    const gameplayRemaining = remainingSecondsFromExpiresAt(
        authoritative.gameplayTimer?.expiresAt
    );

    const timerLabel = useGameplayClock
        ? (phaseLabel ? `GAMEPLAY · ${phaseLabel}` : "GAMEPLAY TIMER")
        : phaseTimerLabel;

    const timerValue = useGameplayClock
        ? (gameplayRemaining === null
            ? "—"
            : formatPhaseTime(gameplayRemaining))
        : (setupRemaining === null
            ? "—"
            : formatPhaseTime(setupRemaining));

    return (

        <div className="infoBar">

            <div className="infoBar__item">

                <span className="infoBar__label">ROOM</span>

                <span className="infoBar__value">{roomIdDisplay}</span>

            </div>

            <div className="infoBar__item">

                <span className="infoBar__label">PLAYERS</span>

                <span className="infoBar__value">{playersDisplay}</span>

            </div>

            <div className="infoBar__item infoBar__item--timer">

                <span className="infoBar__label">{timerLabel}</span>

                <span className="infoBar__value" aria-live="polite">

                    {timerValue}

                </span>

            </div>

        </div>

    );

}
