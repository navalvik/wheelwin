import { useEffect, useMemo, useState } from "react";

import GameLayout from "../layouts/GameLayout";

import { DEV_MODE } from "../config/devMode";

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
import { configurePage5Diagnostics, recordPage5Diagnostic, flushPage5Diagnostics } from "../game/diagnostics/page5Telemetry.js";
import { getLocalPage5Report } from "../game/diagnostics/page5LocalReport.js";
import { createPage5AutoReportSender } from "../game/diagnostics/page5AutoReportSender.js";
import socket from "../socket/socket.js";
import {
    downloadPage5DeviceReport,
    sharePage5DeviceReport,
    copyPage5DeviceReport
} from "../game/diagnostics/page5ReportExport.js";

import { resolveLocalPlayerId } from "../game/session";
import {
    isLocalPlayerWinner,
    resolveAuthoritativeWinnerPlayerId,
    resolvePersonalizedResultPresentation
} from "../game/result/personalizedResultPresentation";

import "../styles/page6result.css";

const PAYMENT_STATUS_LABEL_KEYS = {
    [PAYMENT_VIEW_STATUS.STARTED]: "result.settlementInProgress",
    [PAYMENT_VIEW_STATUS.COMPLETED]: "result.paymentCompleted",
    [PAYMENT_VIEW_STATUS.FAILED]: "result.paymentFailed"
};

const AUDIT_STATUS_LABEL_KEYS = {
    [AUDIT_VIEW_STATUS.STARTED]: "result.auditPending",
    [AUDIT_VIEW_STATUS.READY]: "result.auditCompleted",
    [AUDIT_VIEW_STATUS.FAILED]: "result.auditUnavailable"
};

const EMPTY_VALUE = "—";

function formatValue(value) {

    if (value === null || value === undefined || value === "") {

        return EMPTY_VALUE;

    }

    return value;

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
 * Dynamic amounts are never passed to t().
 */
function resolveYouReceived({ payment, localPlayerId, winnerPlayerId }) {

    if (winnerPlayerId == null || winnerPlayerId === "") {

        return { mode: "fallback" };

    }

    const isWinner = isLocalPlayerWinner(localPlayerId, winnerPlayerId) === true;

    if (!isWinner) {

        return { mode: "key", key: "result.zeroGrm" };

    }

    if (
        payment?.status !== PAYMENT_VIEW_STATUS.COMPLETED
        || payment.winnerAmount === null
        || payment.winnerAmount === undefined
    ) {

        return { mode: "fallback" };

    }

    const amount = Number(payment.winnerAmount);

    if (Number.isFinite(amount)) {

        return { mode: "amount", text: `${amount.toFixed(2)} GRM` };

    }

    return { mode: "key", key: "result.zeroGrm" };

}

function renderYouReceivedAmount(youReceived, payment, t) {

    if (youReceived?.mode === "amount") {

        return youReceived.text;

    }

    if (youReceived?.mode === "key") {

        return t(youReceived.key);

    }

    if (payment) {

        return PAYMENT_STATUS_LABEL_KEYS[payment.status]
            ? t(PAYMENT_STATUS_LABEL_KEYS[payment.status])
            : payment.status;

    }

    return t("result.awaitingSettlement");

}

// Reserved for later C4 stages — layout only, intentionally inert.
const RESERVED_AREA_KEYS = [
    "result.recoveryInformation",
    "result.playAgain",
    "result.roomReturn"
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

    const diagnosticRoomId = authoritative.roomId ?? identity.roomId;
    const diagnosticGameId = result?.gameId ?? identity.gameId ?? authoritative.gameId;
    const resultPresent = Boolean(result);
    const [reportRevision, setReportRevision] = useState(0);
    const [localReportFeedback, setLocalReportFeedback] = useState("");
    const [autoUploadStatus, setAutoUploadStatus] = useState("Waiting for Page6 result...");

    useEffect(() => {

        if (configurePage5Diagnostics({
            roomId: diagnosticRoomId,
            gameId: diagnosticGameId,
            playerId: localPlayerId,
            nickname: identity.nickname
        })) {
            recordPage5Diagnostic({
                kind: "page6_rendered",
                displayedPhase: "RESULT",
                reason: resultPresent ? "result_present" : "result_not_yet_present",
                renderMs: typeof performance !== "undefined"
                    ? Math.round(performance.now()) : null
            });
            flushPage5Diagnostics();
            setReportRevision((current) => current + 1);
        }

    }, [
        diagnosticRoomId, diagnosticGameId, localPlayerId, identity.nickname,
        resultPresent
    ]);

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

    useEffect(() => {
        // Upload is automatic, independent of the existing manual buttons.
        // All retries end when Page6 unmounts; the R2 ZIP is produced
        // server-side after reports or the bounded archive-only grace.
        if (!resultPresent || !diagnosticRoomId || !diagnosticGameId
            || !localPlayerId) return undefined;
        const sender = createPage5AutoReportSender({
            socket,
            roomId: diagnosticRoomId,
            gameId: diagnosticGameId,
            playerId: localPlayerId,
            reportProvider: () => getLocalPage5Report({
                roomId: diagnosticRoomId,
                gameId: diagnosticGameId,
                playerId: localPlayerId
            }),
            onStatus: setAutoUploadStatus
        });
        // The earlier Page6 effect records page6_rendered during this commit.
        sender.start();
        return () => sender.dispose();
    }, [resultPresent, diagnosticRoomId, diagnosticGameId, localPlayerId]);

    const localDeviceReport = useMemo(() => {
        if (!diagnosticRoomId || !diagnosticGameId || !localPlayerId) {
            return null;
        }
        return getLocalPage5Report({
            roomId: diagnosticRoomId,
            gameId: diagnosticGameId,
            playerId: localPlayerId
        });
    }, [diagnosticRoomId, diagnosticGameId, localPlayerId, reportRevision]);

    function handleDownloadTxt() {
        if (!gameReport) return;
        downloadGameReportNative(gameReport, "txt");
    }

    function handleDeviceReportDownload() {
        try {
            const started = downloadPage5DeviceReport(localDeviceReport);
            setLocalReportFeedback(started
                ? "Download requested. If Telegram blocks it, use SHARE or COPY."
                : "Download unavailable. Use SHARE or COPY.");
        } catch {
            setLocalReportFeedback("Download blocked. Use SHARE or COPY.");
        }
    }

    async function handleDeviceReportShare() {
        try {
            const shared = await sharePage5DeviceReport(localDeviceReport);
            setLocalReportFeedback(shared
                ? "Shared using the device menu."
                : "File sharing unavailable. Use DOWNLOAD or COPY.");
        } catch {
            setLocalReportFeedback("Sharing cancelled or blocked. Use COPY.");
        }
    }

    async function handleDeviceReportCopy() {
        try {
            const copied = await copyPage5DeviceReport(localDeviceReport);
            setLocalReportFeedback(copied
                ? "Page5 JSON copied to clipboard."
                : "Clipboard unavailable. Use SHARE or DOWNLOAD.");
        } catch {
            setLocalReportFeedback("Clipboard blocked. Use SHARE or DOWNLOAD.");
        }
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

                            <section className="page6__summary" aria-label={t("result.gameSummary")}>

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
                                        {t(personalizedResult.headlineKey)}
                                    </div>

                                </div>

                                <dl className="page6__facts">

                                    <div className="page6__fact">

                                        <dt>{t("result.winningSector")}</dt>

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

                                        <dt>{t("result.winningColor")}</dt>

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

                                        <dt>{t("result.winnerPayout")}</dt>

                                        <dd>
                                            {winnerPayoutDisplay ?? EMPTY_VALUE}
                                        </dd>

                                    </div>

                                </dl>

                                <div
                                    className="page6__youReceived"
                                    data-status={payment?.status ?? "PENDING"}
                                >

                                    <div className="page6__label">{t("result.youReceived")}</div>

                                    <div className="page6__youReceivedAmount">
                                        {renderYouReceivedAmount(
                                            youReceived,
                                            payment,
                                            t
                                        )}
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
                                            ? (AUDIT_STATUS_LABEL_KEYS[audit.status]
                                                ? t(AUDIT_STATUS_LABEL_KEYS[audit.status])
                                                : audit.status)
                                            : t("result.auditPending")}

                                    </div>

                                </div>

                            </section>

                            <div className="page6__gameReport">

                                <div className="page6__gameReportHeader">

                                    <div className="page6__gameReportTitle">
                                        {t("result.gameReport")} · PAGE5 DIAGNOSTICS
                                    </div>

                                </div>

                                <div className="page6__gameReportPending"
                                    aria-live="polite">
                                    <strong>Automatic upload:</strong> {autoUploadStatus}
                                </div>

                                <div className="page6__gameReportPending">
                                    {localDeviceReport
                                        ? `This phone: ${localDeviceReport.nickname || "PLAYER"} · ${localDeviceReport.metrics.physicsReceived} physics packets · ${localDeviceReport.metrics.wheelPaints} wheel frames · ${localDeviceReport.metrics.mainThreadStalls} long pauses`
                                        : "Local Page5 data not available for this player."}
                                </div>

                                {localDeviceReport?.device && (
                                    <div className="page6__gameReportPending">
                                        Build: {localDeviceReport.device.buildSha?.slice(0, 12) || "unknown"}
                                        {" · "}Telegram: {localDeviceReport.device.telegramVersion || "unknown"}
                                        {" · "}Android: {localDeviceReport.device.androidMajor ?? "n/a"}
                                    </div>
                                )}

                                <div className="page6__gameReportActions">

                                    <button
                                        type="button"
                                        className="page6__downloadBtn"
                                        disabled={!localDeviceReport}
                                        onClick={handleDeviceReportDownload}
                                    >
                                        DOWNLOAD JSON
                                    </button>

                                    <button
                                        type="button"
                                        className="page6__downloadBtn"
                                        disabled={!localDeviceReport}
                                        onClick={handleDeviceReportShare}
                                    >
                                        SHARE FILE
                                    </button>

                                    <button
                                        type="button"
                                        className="page6__downloadBtn"
                                        disabled={!localDeviceReport}
                                        onClick={handleDeviceReportCopy}
                                    >
                                        COPY JSON
                                    </button>

                                    {gameReport && (
                                        <button
                                            type="button"
                                            className="page6__downloadBtn"
                                            onClick={handleDownloadTxt}
                                        >
                                            {t("result.downloadTxt")} · SERVER
                                        </button>
                                    )}

                                </div>

                                <div className="page6__gameReportPending" aria-live="polite">
                                    {localReportFeedback || "Save this phone's report before FINISH; send all three JSON files with the R2 ZIP."}
                                </div>

                            </div>

                        </div>

                    )
                    : (

                        <div className="page6__waiting">

                            {t("result.waitingAuthoritative")}

                        </div>

                    )}

                <div className="page6__reserved" aria-hidden="true">

                    {RESERVED_AREA_KEYS.map((labelKey) => (

                        <div className="page6__reservedSlot" key={labelKey}>

                            {t(labelKey)}

                        </div>

                    ))}

                </div>

            </div>

        </GameLayout>

    );

}
