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

function remainingSecondsFromSetup(setup) {

    if (!setup?.expiresAt) {

        return null;

    }

    return Math.max(0, Math.ceil((setup.expiresAt - Date.now()) / 1000));

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
    const authoritative = useAuthoritativeSession();

    const room = getAuthoritativeRoom(authoritative);

    const { phaseLabel, remainingText } = useGameClock();

    const [, setTick] = useState(0);

    useEffect(() => {

        if (isGameplayPage(currentPage) || !authoritative.setup?.expiresAt) {

            return undefined;

        }

        const timerId = setInterval(() => {

            setTick((value) => value + 1);

        }, 1000);

        return () => clearInterval(timerId);

    }, [currentPage, authoritative.setup?.expiresAt]);

    const roomIdDisplay = formatAuthoritativeRoomId(room.roomId) ?? "—";

    const playersDisplay = formatAuthoritativeRoomPlayersDisplay(
        authoritative.players,
        room.maxPlayers,
        session.maxPlayers
    ) ?? "—";

    // InfoBar is only a router between two independent time domains. Selection is
    // page-based: gameplay/result pages present the authoritative server
    // GameClock, every preparation page presents the Setup Session timer.
    const useGameplayClock = isGameplayPage(currentPage);

    const setupRemaining = remainingSecondsFromSetup(authoritative.setup);

    const timerLabel = useGameplayClock ? phaseLabel : phaseTimerLabel;

    const timerValue = useGameplayClock
        ? remainingText
        : (setupRemaining === null ? "—" : formatPhaseTime(setupRemaining));

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
