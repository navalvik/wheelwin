import { useEffect, useState } from "react";

import { useAuthoritativeSession } from "../context/AuthoritativeSessionContext";
import { useGameClock } from "../context/GameClockContext";
import { useGameSession } from "../context/GameSessionContext";

import {
    formatAuthoritativeRoomId,
    formatAuthoritativeRoomPlayersDisplay,
    getAuthoritativeRoom
} from "../game/session";

import {
    formatClockSeconds,
    remainingSecondsFromExpiresAt,
    resolveClockPhaseLabel,
    resolveGameplayCountdown
} from "../game/gameClock/gameClockView";

import { isGameplayPage } from "../game/sessionRecovery/recoveryFlow";

import "../styles/infoBar.css";

export default function InfoBar() {

    const {
        session,
        currentPage,
        phaseTimerLabel,
        formatPhaseTime
    } = useGameSession();

    const authoritative = useAuthoritativeSession();

    const { clock } = useGameClock();

    const room = getAuthoritativeRoom(authoritative);

    const [, setTick] = useState(0);

    const onGameplayPage = isGameplayPage(currentPage);

    const gameplayEndsAt = onGameplayPage ? clock.endsAt : null;

    const setupExpiresAt = onGameplayPage
        ? null
        : authoritative.setup?.expiresAt;

    useEffect(() => {

        const expiresAt = onGameplayPage ? gameplayEndsAt : setupExpiresAt;

        if (!Number.isFinite(expiresAt)) {

            return undefined;

        }

        const timerId = setInterval(() => {

            setTick((value) => value + 1);

        }, 1000);

        return () => clearInterval(timerId);

    }, [onGameplayPage, gameplayEndsAt, setupExpiresAt]);

    const roomIdDisplay = formatAuthoritativeRoomId(room.roomId) ?? "—";

    const playersDisplay = formatAuthoritativeRoomPlayersDisplay(
        authoritative.players,
        room.maxPlayers,
        session.maxPlayers
    ) ?? "—";

    const setupRemaining = remainingSecondsFromExpiresAt(setupExpiresAt);

    const gameplayRemaining = resolveGameplayCountdown(clock);

    const timerLabel = onGameplayPage
        ? resolveClockPhaseLabel(clock.phase)
        : phaseTimerLabel;

    const timerValue = onGameplayPage
        ? formatClockSeconds(gameplayRemaining)
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
