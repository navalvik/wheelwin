import { useEffect, useMemo } from "react";

import GameLayout from "../layouts/GameLayout";

import { DEV_MODE } from "../config/devMode";

import { resolveWheelIcon } from "../components/game/WheelEngine/wheelUtils";

import { useAuthoritativeSession } from "../context/AuthoritativeSessionContext";
import { useGameResult } from "../context/GameResultContext";
import { usePlayerIdentity } from "../context/PlayerIdentityContext";
import { useWheelConfig } from "../context/WheelConfigContext";

import {
    PAYMENT_VIEW_STATUS,
    AUDIT_VIEW_STATUS
} from "../game/result/gameResultFlow";

import {
    downloadGameReportNative
} from "../game/result/gameReportDownload";

import { resolveLocalPlayerId } from "../game/session";

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
 * Present the authoritative WIN/LOST outcome for the local seat.
 * Does not decide the winner — only compares server winnerId to local id.
 */
function resolveLocalOutcome({ localPlayerId, winnerId }) {

    if (
        localPlayerId == null
        || localPlayerId === ""
        || winnerId == null
        || winnerId === ""
    ) {

        return null;

    }

    return String(localPlayerId) === String(winnerId)
        ? "WIN"
        : "LOST";

}

/**
 * Presentation-only payout line from server payment + winner id.
 */
function resolveYouReceived({ payment, localPlayerId, winnerId }) {

    if (winnerId == null || winnerId === "") {

        return null;

    }

    const isLocalWinner = localPlayerId != null
        && localPlayerId !== ""
        && String(localPlayerId) === String(winnerId);

    if (!isLocalWinner) {

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

    const { result, payment, audit } = useGameResult();

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

        if (DEV_MODE && result) {

            console.debug("[GameResult] Rendering Winner");

        }

    }, [result]);

    const winner = result?.winner ?? null;

    const winningSector = result?.winningSector ?? null;

    const gameReport = audit?.gameReport ?? null;

    const winnerId = payment?.winnerId
        ?? gameReport?.winningPlayer?.playerId
        ?? winner?.id
        ?? null;

    const localReportPlayer = useMemo(
        () => resolvePlayerFromReport(gameReport, localPlayerId),
        [gameReport, localPlayerId]
    );

    const authoritativeLocal = localPlayerId
        ? authoritative.players?.[localPlayerId]
        : null;

    const localNickname = localReportPlayer?.nickname
        ?? authoritativeLocal?.nickname
        ?? null;

    const localIcon = localReportPlayer?.icon
        ?? authoritativeLocal?.icon
        ?? null;

    const winnerNickname = gameReport?.winningPlayer?.nickname
        ?? resolvePlayerFromReport(gameReport, winnerId)?.nickname
        ?? (winnerId && authoritative.players?.[winnerId]?.nickname)
        ?? null;

    const winnerIcon = gameReport?.winningIcon
        ?? gameReport?.winningPlayer?.icon
        ?? winner?.icon
        ?? null;

    const winningSwatchColor = useMemo(
        () => resolveWinningSwatchColor(winningSector, wheelConfiguration),
        [winningSector, wheelConfiguration]
    );

    const localOutcome = useMemo(
        () => resolveLocalOutcome({ localPlayerId, winnerId }),
        [localPlayerId, winnerId]
    );

    const youReceived = useMemo(
        () => resolveYouReceived({ payment, localPlayerId, winnerId }),
        [payment, localPlayerId, winnerId]
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
            message="GAME FINISHED"
            showNextButton={true}
            nextEnabled={typeof onFinish === "function"}
            nextLabel="FINISH"
            onNext={onFinish}
            showJumpButton={false}
        >

            <div className="page6" data-has-result={Boolean(result)}>

                <div className="page6__headline">GAME FINISHED</div>

                {result
                    ? (

                        <div className="page6__result">

                            <section className="page6__summary" aria-label="Game summary">

                                <div className="page6__localPlayer">

                                    <div className="page6__localIcon">
                                        {formatIcon(localIcon)}
                                    </div>

                                    <div className="page6__localBody">

                                        <div className="page6__label">Player</div>

                                        <div className="page6__localName">
                                            {formatValue(localNickname)}
                                        </div>

                                    </div>

                                    {localOutcome && (

                                        <div
                                            className={
                                                localOutcome === "WIN"
                                                    ? "page6__outcome page6__outcome--win"
                                                    : "page6__outcome page6__outcome--lost"
                                            }
                                        >
                                            {localOutcome}
                                        </div>

                                    )}

                                </div>

                                <div
                                    className="page6__winnerCard"
                                    style={{ borderColor: winningSwatchColor }}
                                >

                                    <div className="page6__winnerIcon">
                                        {formatIcon(winnerIcon)}
                                    </div>

                                    <div className="page6__winnerBody">

                                        <div className="page6__label">Winner</div>

                                        <div className="page6__winnerName">
                                            {formatValue(winnerNickname ?? winnerId)}
                                        </div>

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
