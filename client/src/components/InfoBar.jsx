import { useEffect, useRef, useState } from "react";

import { useAuthoritativeSession } from "../context/AuthoritativeSessionContext";
import { useGameClock } from "../context/GameClockContext";
import { useGameResult } from "../context/GameResultContext";
import { useGameSession } from "../context/GameSessionContext";
import { useLanguage } from "../context/LanguageContext";
import { usePlayerIdentity } from "../context/PlayerIdentityContext";

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
    classifyInfoBarFooterMode,
    page6LifecycleDiag
} from "../game/result/page6LifecycleDiag";

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

    const { getIdentity } = usePlayerIdentity();

    const { t } = useLanguage();

    const room = getAuthoritativeRoom(authoritative);

    const [, setTick] = useState(0);

    const lastFooterDiagRef = useRef("");

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

    let footerMode;

    if (onResultPage) {

        // R12.5B — Page6 footer shows authoritative Result Session lifetime.
        footerMode = "PAGE6_TIME_LEFT";

        timerLabel = t("page.result.timeLeft");

        timerValue = formatResultSessionClock(resultRemaining) ?? "—";

    } else if (onGameplayPage) {

        footerMode = "PAGE5_RESULT_OR_GAMEPLAY";

        timerLabel = resolveClockPhaseLabel(clock.phase);

        timerValue = formatClockSeconds(gameplayRemaining);

    } else {

        footerMode = "SETUP_OR_OTHER";

        timerLabel = phaseTimerLabel;

        timerValue = setupRemaining === null
            ? "—"
            : formatPhaseTime(setupRemaining);

    }

    // R12.5E — observe footer branch only when the visible decision changes.
    const footerFingerprint = [
        footerMode,
        currentPage,
        timerLabel,
        timerValue,
        resultSessionExpiresAt ?? "null",
        clock.phase ?? "null"
    ].join("|");

    if (
        (onResultPage || onGameplayPage)
        && lastFooterDiagRef.current !== footerFingerprint
    ) {

        lastFooterDiagRef.current = footerFingerprint;

        const identity = getIdentity?.() ?? {};

        page6LifecycleDiag("INFOBAR_FOOTER", {
            roomId: room.roomId ?? identity.roomId ?? null,
            playerId: identity.playerId ?? null,
            currentPage,
            gameState: clock.phase ?? null,
            resultSessionExpiresAt: Number.isFinite(resultSessionExpiresAt)
                ? resultSessionExpiresAt
                : null,
            remainingResultSessionSeconds: resultRemaining,
            footerMode,
            classifiedMode: classifyInfoBarFooterMode({
                currentPage,
                onResultPage,
                onGameplayPage
            }),
            timerLabel,
            timerValue,
            onResultPage,
            onGameplayPage
        }, { key: "INFOBAR_FOOTER" });

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
