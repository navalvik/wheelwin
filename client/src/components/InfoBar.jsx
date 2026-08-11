import { useEffect, useState } from "react";

import { useAuthoritativeSession } from "../context/AuthoritativeSessionContext";
import { useGameClock } from "../context/GameClockContext";
import { useGameResult } from "../context/GameResultContext";
import { useGameSession } from "../context/GameSessionContext";
import { useLanguage } from "../context/LanguageContext";

import {
    formatAuthoritativeRoomId,
    formatAuthoritativeRoomPlayersDisplay,
    getAuthoritativeRoom
} from "../game/session";

import {
    formatClockSeconds,
    remainingSecondsFromEndsAt,
    resolveClockPhaseLabel,
    resolveGameplayCountdown
} from "../game/gameClock/gameClockView";

import {
    formatResultSessionClock,
    remainingResultSessionSeconds
} from "../game/result/resultSessionCountdown";

import {
    APP_PAGES,
    isGameplayPage
} from "../game/sessionRecovery/recoveryFlow";

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

    const { resultSessionExpiresAt } = useGameResult();

    const { t } = useLanguage();

    const room = getAuthoritativeRoom(authoritative);

    const [, setTick] = useState(0);

    const onResultPage = currentPage === APP_PAGES.RESULT;

    const onGameplayPage = isGameplayPage(currentPage);

    const gameplayEndsAt = onGameplayPage && !onResultPage
        ? clock.endsAt
        : null;

    const setupExpiresAt = onGameplayPage
        ? null
        : authoritative.setup?.expiresAt;

    const resultExpiresAt = onResultPage
        ? resultSessionExpiresAt
        : null;

    useEffect(() => {

        const expiresAt = onResultPage
            ? resultExpiresAt
            : (onGameplayPage ? gameplayEndsAt : setupExpiresAt);

        if (!Number.isFinite(expiresAt)) {

            return undefined;

        }

        const timerId = setInterval(() => {

            setTick((value) => value + 1);

        }, 1000);

        return () => clearInterval(timerId);

    }, [
        onResultPage,
        onGameplayPage,
        gameplayEndsAt,
        setupExpiresAt,
        resultExpiresAt
    ]);

    const roomIdDisplay = formatAuthoritativeRoomId(room.roomId) ?? "—";

    const playersDisplay = formatAuthoritativeRoomPlayersDisplay(
        authoritative.players,
        room.maxPlayers,
        session.maxPlayers
    ) ?? "—";

    const setupRemaining = remainingSecondsFromEndsAt(setupExpiresAt);

    const gameplayRemaining = resolveGameplayCountdown(clock);

    const resultRemaining = remainingResultSessionSeconds(resultExpiresAt);

    let timerLabel;

    let timerValue;

    if (onResultPage) {

        // R12.5B — Page6 footer shows authoritative Result Session lifetime.
        timerLabel = t("page.result.timeLeft");

        timerValue = formatResultSessionClock(resultRemaining) ?? "—";

    } else if (onGameplayPage) {

        timerLabel = resolveClockPhaseLabel(clock.phase);

        timerValue = formatClockSeconds(gameplayRemaining);

    } else {

        timerLabel = phaseTimerLabel;

        timerValue = setupRemaining === null
            ? "—"
            : formatPhaseTime(setupRemaining);

    }

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
