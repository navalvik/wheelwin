import { useEffect, useMemo } from "react";

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
 */
function resolveYouReceived({ payment, localPlayerId, winnerPlayerId }) {

    if (winnerPlayerId == null || winnerPlayerId === "") {

        return null;

    }

    const isWinner = isLocalPlayerWinner(localPlayerId, winnerPlayerId) === true;

    if (!isWinner) {

        return "result.zeroGrm";

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
        : "result.zeroGrm";

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
                                        {(youReceived
                                            ? (youReceived.includes(".")
                                                ? t(youReceived)
                                                : youReceived)
                                            : null)
                                            ?? (payment
                                                ? (PAYMENT_STATUS_LABEL_KEYS[payment.status]
                                                    ? t(PAYMENT_STATUS_LABEL_KEYS[payment.status])
                                                    : payment.status)
                                                : t("result.awaitingSettlement"))}
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

                            {gameReport ? (

                                <div className="page6__gameReport">

                                    <div className="page6__gameReportHeader">

                                        <div className="page6__gameReportTitle">
                                            {t("result.gameReport")}
                                        </div>

                                        <div className="page6__gameReportActions">

                                            <button
                                                type="button"
                                                className="page6__downloadBtn"
                                                onClick={handleDownloadTxt}
                                            >
                                                {t("result.downloadTxt")}
                                            </button>

                                        </div>

                                    </div>

                                </div>

                            ) : (

                                <div className="page6__gameReport page6__gameReport--pending">

                                    <div className="page6__gameReportTitle">
                                        {t("result.gameReport")}
                                    </div>

                                    <div className="page6__gameReportPending">
                                        {t("result.awaitingReport")}
                                    </div>

                                </div>

                            )}

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
