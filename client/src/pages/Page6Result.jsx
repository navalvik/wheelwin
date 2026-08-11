import { useEffect, useMemo } from "react";

import GameLayout from "../layouts/GameLayout";

import { DEV_MODE } from "../config/devMode";

import { resolveWheelIcon } from "../components/game/WheelEngine/wheelUtils";

import { useAuthoritativeSession } from "../context/AuthoritativeSessionContext";
import { useGameResult } from "../context/GameResultContext";
import { useGameSession } from "../context/GameSessionContext";
import { useLanguage } from "../context/LanguageContext";
import { usePlayerIdentity } from "../context/PlayerIdentityContext";
import { useWheelConfig } from "../context/WheelConfigContext";

import {
    PAYMENT_VIEW_STATUS,
    AUDIT_VIEW_STATUS
} from "../game/result/gameResultFlow";

import {
    downloadGameReportNative
} from "../game/result/gameReportDownload";

import {
    remainingResultSessionSeconds
} from "../game/result/resultSessionCountdown";

import {
    clearPage6MountSnapshot,
    notePage6MountSnapshot,
    webPage6Diag
} from "../game/result/webPage6StateDiag";

import { APP_PAGES } from "../game/sessionRecovery/recoveryFlow";

import { resolveLocalPlayerId } from "../game/session";
import {
    isLocalPlayerWinner,
    resolveAuthoritativeWinnerPlayerId,
    resolvePersonalizedResultPresentation
} from "../game/result/personalizedResultPresentation";

import "../styles/page6result.css";

const PAYMENT_STATUS_LABEL = {
    [PAYMENT_VIEW_STATUS.STARTED]: "Settlement in progress…",
    [PAYMENT_VIEW_STATUS.COMPLETED]: "Payment completed",
    [PAYMENT_VIEW_STATUS.FAILED]: "Payment failed"
};

const AUDIT_STATUS_LABEL = {
    [AUDIT_VIEW_STATUS.STARTED]: "Audit pending",
    [AUDIT_VIEW_STATUS.READY]: "Audit completed",
    [AUDIT_VIEW_STATUS.FAILED]: "Audit unavailable"
};

const EMPTY_VALUE = "—";

function formatValue(value) {

    if (value === null || value === undefined || value === "") {

        return EMPTY_VALUE;

    }

    return value;

}

function formatIcon(icon) {

    if (icon === null || icon === undefined || icon === "") {

        return EMPTY_VALUE;

    }

    return resolveWheelIcon(icon);

}

function formatAngle(angle) {

    if (typeof angle !== "number" || Number.isNaN(angle)) {

        return EMPTY_VALUE;

    }

    return `${angle.toFixed(2)}°`;

}

function formatTimestamp(timestamp) {

    if (typeof timestamp !== "number" || Number.isNaN(timestamp)) {

        return EMPTY_VALUE;

    }

    return new Date(timestamp).toISOString();

}

/**
 * Page6 presentation: resolve the swatch to the same fill color Page5 uses.
 */
function resolveWinningSwatchColor(winningSector, wheelConfiguration) {

    const sectorColor = winningSector?.color;

    if (typeof sectorColor === "string" && sectorColor.startsWith("#")) {

        return sectorColor;

    }

    const sectorId = winningSector?.sectorId;

    if (sectorId && Array.isArray(wheelConfiguration?.sectors)) {

        const wheelSector = wheelConfiguration.sectors.find(
            (sector) => sector?.sectorId === sectorId
        );

        if (
            typeof wheelSector?.color === "string"
            && wheelSector.color.startsWith("#")
        ) {

            return wheelSector.color;

        }

    }

    return undefined;

}

/**
 * Presentation-only payout line from server payment + winner id.
 */
function resolveYouReceived({ payment, localPlayerId, winnerPlayerId }) {

    if (winnerPlayerId == null || winnerPlayerId === "") {

        return null;

    }

    const isWinner = isLocalPlayerWinner(localPlayerId, winnerPlayerId) === true;

    if (!isWinner) {

        return "0.00 GRM";

    }

    if (
        payment?.status !== PAYMENT_VIEW_STATUS.COMPLETED
        || payment.winnerAmount === null
        || payment.winnerAmount === undefined
    ) {

        return null;

    }

    const amount = Number(payment.winnerAmount);

    return Number.isFinite(amount)
        ? `${amount.toFixed(2)} GRM`
        : "0.00 GRM";

}

function resolvePlayerFromReport(gameReport, playerId) {

    if (!gameReport || playerId == null) {

        return null;

    }

    return (gameReport.players ?? []).find(
        (player) => String(player.playerId) === String(playerId)
    ) ?? null;

}

// Reserved for later C4 stages — layout only, intentionally inert.
const RESERVED_AREAS = [
    "Recovery Information",
    "Play Again",
    "Room Return"
];

export default function Page6Result({ onFinish }) {

    const { result, payment, audit, resultSessionExpiresAt } = useGameResult();

    const { currentPage } = useGameSession();

    const { t } = useLanguage();

    const { identity } = usePlayerIdentity();

    const authoritative = useAuthoritativeSession();

    const { wheelConfiguration } = useWheelConfig();

    const localPlayerId = resolveLocalPlayerId(
        identity.playerId ?? null,
        authoritative.players,
        {
            verifyCompleted: Boolean(authoritative.lifecycle?.verifyCompleted)
        }
    );

    useEffect(() => {

        const source = "GameSessionContext.currentPage";

        notePage6MountSnapshot({
            currentPage,
            source,
            resultSessionExpiresAt
        });

        webPage6Diag("PAGE6_RENDER_STATE", {
            playerId: localPlayerId,
            roomId: authoritative.roomId ?? identity.roomId ?? null,
            gameId: result?.gameId ?? null,
            currentPage,
            currentPageType: typeof currentPage,
            appPagesResult: APP_PAGES.RESULT,
            page6Mounted: true,
            hasResult: Boolean(result),
            resultSessionExpiresAt: Number.isFinite(resultSessionExpiresAt)
                ? resultSessionExpiresAt
                : null,
            remainingResultSessionSeconds: remainingResultSessionSeconds(
                resultSessionExpiresAt
            ),
            navigationSource: source
        }, { key: "PAGE6_RENDER_STATE" });

        webPage6Diag("PAGE_STATE_SOURCE", {
            component: "Page6Result",
            source,
            currentPage,
            currentPageType: typeof currentPage,
            appPagesResult: APP_PAGES.RESULT,
            equalsAppPagesResult: currentPage === APP_PAGES.RESULT,
            playerId: localPlayerId,
            roomId: authoritative.roomId ?? identity.roomId ?? null
        }, { key: "PAGE_STATE_SOURCE_PAGE6" });

        return () => {

            clearPage6MountSnapshot();

            webPage6Diag("PAGE6_UNMOUNT", {
                playerId: localPlayerId,
                roomId: authoritative.roomId ?? identity.roomId ?? null,
                currentPageBeforeUnmount: currentPage
            }, { force: true });

        };

    }, [
        authoritative.roomId,
        currentPage,
        identity.roomId,
        localPlayerId,
        result,
        resultSessionExpiresAt
    ]);

    useEffect(() => {

        if (DEV_MODE && result) {

            console.debug("[GameResult] Rendering personalized outcome");

        }

    }, [result]);

    const winner = result?.winner ?? null;

    const winningSector = result?.winningSector ?? null;

    const gameReport = audit?.gameReport ?? null;

    const winnerPlayerId = resolveAuthoritativeWinnerPlayerId({
        result,
        payment,
        gameReport
    });

    const personalizedResult = useMemo(
        () => resolvePersonalizedResultPresentation(
            isLocalPlayerWinner(localPlayerId, winnerPlayerId)
        ),
        [localPlayerId, winnerPlayerId]
    );

    const youReceived = useMemo(
        () => resolveYouReceived({ payment, localPlayerId, winnerPlayerId }),
        [payment, localPlayerId, winnerPlayerId]
    );

    const winningSwatchColor = useMemo(
        () => resolveWinningSwatchColor(winningSector, wheelConfiguration),
        [winningSector, wheelConfiguration]
    );

    const winnerPayoutDisplay = useMemo(() => {

        if (gameReport?.winnerPayout != null) {

            return `${Number(gameReport.winnerPayout).toFixed(2)} GRM`;

        }

        if (
            payment?.status === PAYMENT_VIEW_STATUS.COMPLETED
            && payment.winnerAmount != null
        ) {

            return `${Number(payment.winnerAmount).toFixed(2)} GRM`;

        }

        return null;

    }, [gameReport, payment]);

    function handleDownloadJson() {

        if (!gameReport) {

            return;

        }

        downloadGameReportNative(gameReport, "json");

    }

    function handleDownloadTxt() {

        if (!gameReport) {

            return;

        }

        downloadGameReportNative(gameReport, "txt");

    }

    return (

        <GameLayout
            message={t("page.result.title")}
            showNextButton={true}
            nextEnabled={typeof onFinish === "function"}
            nextLabel={t("common.finish")}
            onNext={onFinish}
            showJumpButton={false}
        >

            <div className="page6" data-has-result={Boolean(result)}>

                <div className="page6__headline">{t("page.result.title")}</div>

                {result
                    ? (

                        <div className="page6__result">

                            <section className="page6__summary" aria-label="Game summary">

                                <div
                                    className={
                                        personalizedResult.variant === "win"
                                            ? "page6__personalOutcome page6__personalOutcome--win"
                                            : personalizedResult.variant === "lost"
                                                ? "page6__personalOutcome page6__personalOutcome--lost"
                                                : "page6__personalOutcome"
                                    }
                                >

                                    {personalizedResult.trophy && (

                                        <div
                                            className="page6__personalTrophy"
                                            aria-hidden="true"
                                        >
                                            {personalizedResult.trophy}
                                        </div>

                                    )}

                                    <div className="page6__personalHeadline">
                                        {personalizedResult.headline}
                                    </div>

                                </div>

                                <dl className="page6__facts">

                                    <div className="page6__fact">

                                        <dt>Winning Sector</dt>

                                        <dd>

                                            {formatValue(
                                                gameReport?.winningSector?.sectorId
                                                    ?? winningSector?.sectorId
                                            )}

                                            {typeof (
                                                gameReport?.winningSector?.index
                                                    ?? winningSector?.index
                                            ) === "number"
                                                ? ` (#${(
                                                    gameReport?.winningSector?.index
                                                        ?? winningSector?.index
                                                ) + 1})`
                                                : ""}

                                        </dd>

                                    </div>

                                    <div className="page6__fact">

                                        <dt>Winning Color</dt>

                                        <dd>

                                            <span
                                                className="page6__swatch"
                                                style={{
                                                    backgroundColor:
                                                        winningSwatchColor
                                                }}
                                            />

                                            {formatValue(
                                                gameReport?.winningColor
                                                    ?? winner?.color
                                            )}

                                        </dd>

                                    </div>

                                    <div className="page6__fact">

                                        <dt>Winner Payout</dt>

                                        <dd>
                                            {winnerPayoutDisplay ?? EMPTY_VALUE}
                                        </dd>

                                    </div>

                                </dl>

                                <div
                                    className="page6__youReceived"
                                    data-status={payment?.status ?? "PENDING"}
                                >

                                    <div className="page6__label">You received</div>

                                    <div className="page6__youReceivedAmount">
                                        {youReceived
                                            ?? (payment
                                                ? (PAYMENT_STATUS_LABEL[payment.status]
                                                    ?? payment.status)
                                                : "Awaiting settlement…")}
                                    </div>

                                    {payment?.status === PAYMENT_VIEW_STATUS.FAILED
                                        && DEV_MODE && payment.reason && (

                                        <div className="page6__paymentReason">
                                            {payment.reason}
                                        </div>

                                    )}

                                </div>

                                <div
                                    className="page6__audit"
                                    data-status={audit?.status ?? "PENDING"}
                                    aria-live="polite"
                                >

                                    <div className="page6__auditLabel">

                                        {audit
                                            ? (AUDIT_STATUS_LABEL[audit.status]
                                                ?? audit.status)
                                            : "Audit pending"}

                                    </div>

                                </div>

                            </section>

                            {gameReport ? (

                                <div className="page6__gameReport">

                                    <div className="page6__gameReportHeader">

                                        <div className="page6__gameReportTitle">
                                            Game Report
                                        </div>

                                        <div className="page6__gameReportActions">

                                            <button
                                                type="button"
                                                className="page6__downloadBtn"
                                                onClick={handleDownloadJson}
                                            >
                                                Download JSON
                                            </button>

                                            <button
                                                type="button"
                                                className="page6__downloadBtn"
                                                onClick={handleDownloadTxt}
                                            >
                                                Download TXT
                                            </button>

                                        </div>

                                    </div>

                                    <div className="page6__gameReportScroll">

                                        <div className="page6__reportRow">
                                            <span>Report ID</span>
                                            <span>{formatValue(gameReport.reportId)}</span>
                                        </div>

                                        <div className="page6__reportRow">
                                            <span>Game ID</span>
                                            <span>{formatValue(gameReport.gameId)}</span>
                                        </div>

                                        <div className="page6__reportRow">
                                            <span>Room ID</span>
                                            <span>{formatValue(gameReport.roomId)}</span>
                                        </div>

                                        <div className="page6__reportRow">
                                            <span>Audit Trace ID</span>
                                            <span>{formatValue(gameReport.auditTraceId)}</span>
                                        </div>

                                        <div className="page6__reportRow">
                                            <span>Game Start</span>
                                            <span>{formatTimestamp(gameReport.gameStartTime)}</span>
                                        </div>

                                        <div className="page6__reportRow">
                                            <span>Game Finish</span>
                                            <span>{formatTimestamp(gameReport.gameFinishTime)}</span>
                                        </div>

                                        <div className="page6__reportRow">
                                            <span>Duration</span>
                                            <span>
                                                {Number.isFinite(gameReport.gameDurationMs)
                                                    ? `${gameReport.gameDurationMs} ms`
                                                    : EMPTY_VALUE}
                                            </span>
                                        </div>

                                        <div className="page6__reportRow">
                                            <span>Server Timestamp</span>
                                            <span>{formatTimestamp(gameReport.serverTimestamp)}</span>
                                        </div>

                                        <div className="page6__reportRow">
                                            <span>Final Wheel Angle</span>
                                            <span>{formatAngle(gameReport.finalWheelAngle)}</span>
                                        </div>

                                        <div className="page6__reportRow">
                                            <span>Winning Sector</span>
                                            <span>{formatValue(gameReport.winningSector?.sectorId)}</span>
                                        </div>

                                        <div className="page6__reportRow">
                                            <span>Winning Color</span>
                                            <span>{formatValue(gameReport.winningColor)}</span>
                                        </div>

                                        <div className="page6__reportRow">
                                            <span>Winning Icon</span>
                                            <span>{formatIcon(gameReport.winningIcon)}</span>
                                        </div>

                                        <div className="page6__reportRow">
                                            <span>Winning Player</span>
                                            <span>
                                                {formatValue(
                                                    gameReport.winningPlayer?.nickname
                                                        ?? gameReport.winningPlayer?.playerId
                                                )}
                                            </span>
                                        </div>

                                        <div className="page6__reportRow">
                                            <span>Winner Payout</span>
                                            <span>
                                                {gameReport.winnerPayout == null
                                                    ? EMPTY_VALUE
                                                    : `${gameReport.winnerPayout} GRM`}
                                            </span>
                                        </div>

                                        <div className="page6__reportRow">
                                            <span>WheelWin Commission</span>
                                            <span>
                                                {gameReport.wheelWinCommission == null
                                                    ? EMPTY_VALUE
                                                    : `${gameReport.wheelWinCommission} GRM`}
                                            </span>
                                        </div>

                                        <div className="page6__reportRow">
                                            <span>Total Prize Pool</span>
                                            <span>
                                                {gameReport.totalPrizePool == null
                                                    ? EMPTY_VALUE
                                                    : `${gameReport.totalPrizePool} GRM`}
                                            </span>
                                        </div>

                                        <div className="page6__reportRow">
                                            <span>Base Stake</span>
                                            <span>{formatValue(gameReport.baseStake)}</span>
                                        </div>

                                        <div className="page6__reportRow">
                                            <span>Total Sectors</span>
                                            <span>{formatValue(gameReport.totalSectorCount)}</span>
                                        </div>

                                        <div className="page6__reportRow">
                                            <span>Game Version</span>
                                            <span>{formatValue(gameReport.gameVersion)}</span>
                                        </div>

                                        {(gameReport.players ?? []).map((player) => (

                                            <div
                                                className="page6__reportPlayer"
                                                key={player.playerId ?? player.index}
                                            >

                                                <div className="page6__reportPlayerTitle">
                                                    Player {player.index}
                                                    {" — "}
                                                    {player.result}
                                                </div>

                                                <div className="page6__reportRow">
                                                    <span>Nickname</span>
                                                    <span>{formatValue(player.nickname)}</span>
                                                </div>

                                                <div className="page6__reportRow">
                                                    <span>Player ID</span>
                                                    <span>{formatValue(player.playerId)}</span>
                                                </div>

                                                <div className="page6__reportRow">
                                                    <span>Icon</span>
                                                    <span>{formatIcon(player.icon)}</span>
                                                </div>

                                                <div className="page6__reportRow">
                                                    <span>Sectors</span>
                                                    <span>{formatValue(player.sectorCount)}</span>
                                                </div>

                                                <div className="page6__reportRow">
                                                    <span>Colors</span>
                                                    <span>
                                                        {Array.isArray(player.sectorColors)
                                                            ? player.sectorColors.join(", ")
                                                            : EMPTY_VALUE}
                                                    </span>
                                                </div>

                                                <div className="page6__reportRow">
                                                    <span>Paid</span>
                                                    <span>
                                                        {player.amountPaid == null
                                                            ? EMPTY_VALUE
                                                            : `${player.amountPaid} GRM`}
                                                    </span>
                                                </div>

                                                <div className="page6__reportRow">
                                                    <span>Wallet</span>
                                                    <span>{formatValue(player.walletAddress)}</span>
                                                </div>

                                                <div className="page6__reportRow">
                                                    <span>Prize</span>
                                                    <span>
                                                        {player.prizeReceived == null
                                                            ? EMPTY_VALUE
                                                            : `${player.prizeReceived} GRM`}
                                                    </span>
                                                </div>

                                            </div>

                                        ))}

                                    </div>

                                </div>

                            ) : (

                                <div className="page6__gameReport page6__gameReport--pending">

                                    <div className="page6__gameReportTitle">
                                        Game Report
                                    </div>

                                    <div className="page6__gameReportPending">
                                        Awaiting authoritative report…
                                    </div>

                                </div>

                            )}

                        </div>

                    )
                    : (

                        <div className="page6__waiting">

                            Waiting for the authoritative result…

                        </div>

                    )}

                <div className="page6__reserved" aria-hidden="true">

                    {RESERVED_AREAS.map((label) => (

                        <div className="page6__reservedSlot" key={label}>

                            {label}

                        </div>

                    ))}

                </div>

            </div>

        </GameLayout>

    );

}
