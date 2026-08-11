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

import { remainingResultSessionSeconds } from "../game/result/resultSessionCountdown";

import {
    classifyInfoBarFooterMode,
    page6LifecycleDiag
} from "../game/result/page6LifecycleDiag";

import {
    classifyPage6InfoBarCombination,
    detectCurrentPageSourceSplit,
    getPage6MountSnapshot,
    webPage6Diag
} from "../game/result/webPage6StateDiag";

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

    // R12.5H — Page6 has no lifetime countdown tick.
    useEffect(() => {

        if (onResultPage) {

            return undefined;

        }

        const expiresAt = onGameplayPage ? gameplayEndsAt : setupExpiresAt;

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
        setupExpiresAt
    ]);

    const roomIdDisplay = formatAuthoritativeRoomId(room.roomId) ?? "—";

    const playersDisplay = formatAuthoritativeRoomPlayersDisplay(
        authoritative.players,
        room.maxPlayers,
        session.maxPlayers
    ) ?? "—";

    const setupRemaining = remainingSecondsFromEndsAt(setupExpiresAt);

    const gameplayRemaining = resolveGameplayCountdown(clock);

    // Diagnostic-only remaining (not shown on Page6 after R12.5H).
    const resultRemaining = onResultPage
        ? remainingResultSessionSeconds(resultSessionExpiresAt)
        : null;

    let timerLabel;

    let timerValue;

    let footerMode;

    if (onResultPage) {

        // R12.5H — Page6 exit is FINISH-only; no lifetime countdown UI.
        footerMode = "PAGE6_NEUTRAL";

        timerLabel = "—";

        timerValue = "—";

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

        const page6Snap = getPage6MountSnapshot();

        const page6Mounted = page6Snap != null;

        const combination = classifyPage6InfoBarCombination({
            page6Mounted,
            infoBarCurrentPage: currentPage,
            footerMode,
            timerLabel,
            timerValue
        });

        const sourceSplit = detectCurrentPageSourceSplit({
            page6CurrentPage: page6Snap?.currentPage ?? null,
            infoBarCurrentPage: currentPage,
            page6Source: page6Snap?.source ?? null,
            infoBarSource: "GameSessionContext.currentPage"
        });

        webPage6Diag("INFOBAR_STATE", {
            playerId: identity.playerId ?? null,
            roomId: room.roomId ?? identity.roomId ?? null,
            currentPage,
            currentPageType: typeof currentPage,
            appPagesResult: APP_PAGES.RESULT,
            equalsAppPagesResult: currentPage === APP_PAGES.RESULT,
            gameState: clock.phase ?? null,
            footerMode,
            selectedLabel: timerLabel,
            selectedValue: timerValue,
            resultSessionExpiresAt: Number.isFinite(resultSessionExpiresAt)
                ? resultSessionExpiresAt
                : null,
            remainingResultSessionSeconds: resultRemaining,
            page6Mounted,
            combination
        }, { key: "INFOBAR_STATE" });

        webPage6Diag("PAGE_STATE_SOURCE", {
            component: "InfoBar",
            source: "GameSessionContext.currentPage",
            currentPage,
            currentPageType: typeof currentPage,
            appPagesResult: APP_PAGES.RESULT,
            equalsAppPagesResult: currentPage === APP_PAGES.RESULT,
            page6Mounted,
            page6CurrentPage: page6Snap?.currentPage ?? null,
            page6Source: page6Snap?.source ?? null,
            splitDetected: sourceSplit.splitDetected === true,
            sameValue: sourceSplit.sameValue,
            sameSource: sourceSplit.sameSource,
            combination,
            playerId: identity.playerId ?? null,
            roomId: room.roomId ?? identity.roomId ?? null
        }, { key: "PAGE_STATE_SOURCE_INFOBAR" });

        if (combination === "C_PAGE6_BODY_RESULT_FOOTER" || sourceSplit.splitDetected) {

            webPage6Diag("STATE_SPLIT_DETECTED", {
                combination,
                ...sourceSplit,
                footerMode,
                selectedLabel: timerLabel,
                selectedValue: timerValue,
                resultSessionExpiresAt: Number.isFinite(resultSessionExpiresAt)
                    ? resultSessionExpiresAt
                    : null,
                playerId: identity.playerId ?? null,
                roomId: room.roomId ?? identity.roomId ?? null
            }, { force: true });

        }

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
