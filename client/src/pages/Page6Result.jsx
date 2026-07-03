import { useEffect } from "react";

import GameLayout from "../layouts/GameLayout";

import { DEV_MODE } from "../config/devMode";

import { useGameResult } from "../context/GameResultContext";

import {
    PAYMENT_VIEW_STATUS,
    AUDIT_VIEW_STATUS
} from "../game/result/gameResultFlow";

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

// Reserved for later C4 stages — layout only, intentionally inert.
const RESERVED_AREAS = [
    "Recovery Information",
    "Play Again",
    "Room Return"
];

export default function Page6Result() {

    const { result, payment, audit } = useGameResult();

    useEffect(() => {

        if (DEV_MODE && result) {

            console.debug("[GameResult] Rendering Winner");

        }

    }, [result]);

    const winner = result?.winner ?? null;

    const winningSector = result?.winningSector ?? null;

    return (

        <GameLayout
            message="GAME FINISHED"
            showNextButton={false}
            nextEnabled={false}
            onNext={() => {}}
        >

            <div className="page6" data-has-result={Boolean(result)}>

                <div className="page6__headline">GAME FINISHED</div>

                {result
                    ? (

                        <div className="page6__result">

                            <div
                                className="page6__winnerCard"
                                style={{ borderColor: winner?.color ?? undefined }}
                            >

                                <div className="page6__winnerIcon">

                                    {formatValue(winner?.icon)}

                                </div>

                                <div className="page6__winnerBody">

                                    <div className="page6__label">Winner</div>

                                    <div className="page6__winnerName">

                                        {formatValue(winner?.id)}

                                    </div>

                                </div>

                            </div>

                            <dl className="page6__facts">

                                <div className="page6__fact">

                                    <dt>Winning Color</dt>

                                    <dd>

                                        <span
                                            className="page6__swatch"
                                            style={{
                                                backgroundColor:
                                                    winner?.color ?? undefined
                                            }}
                                        />

                                        {formatValue(winner?.color)}

                                    </dd>

                                </div>

                                <div className="page6__fact">

                                    <dt>Winning Icon</dt>

                                    <dd>{formatValue(winner?.icon)}</dd>

                                </div>

                                <div className="page6__fact">

                                    <dt>Winning Sector</dt>

                                    <dd>

                                        {formatValue(winningSector?.sectorId)}

                                        {typeof winningSector?.index === "number"
                                            ? ` (#${winningSector.index + 1})`
                                            : ""}

                                    </dd>

                                </div>

                            </dl>

                            <div
                                className="page6__payment"
                                data-status={payment?.status ?? "PENDING"}
                                aria-live="polite"
                            >

                                <div className="page6__paymentLabel">

                                    {payment
                                        ? (PAYMENT_STATUS_LABEL[payment.status]
                                            ?? payment.status)
                                        : "Awaiting settlement…"}

                                </div>

                                {payment?.status === PAYMENT_VIEW_STATUS.COMPLETED
                                    && payment.winnerAmount !== null
                                    && payment.winnerAmount !== undefined && (

                                    <div className="page6__paymentAmount">

                                        Payout: {payment.winnerAmount}

                                    </div>

                                )}

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

                                {DEV_MODE && audit?.auditId && (

                                    <div className="page6__auditDetail">

                                        <div className="page6__devRow">
                                            <span>Audit ID</span>
                                            <span>{audit.auditId}</span>
                                        </div>

                                        <div className="page6__devRow">
                                            <span>Audit Timestamp</span>
                                            <span>
                                                {formatTimestamp(
                                                    audit.serverTimestamp
                                                )}
                                            </span>
                                        </div>

                                    </div>

                                )}

                            </div>

                            {DEV_MODE && (

                                <div className="page6__dev">

                                    <div className="page6__devTitle">
                                        Development Info
                                    </div>

                                    <div className="page6__devRow">
                                        <span>Game ID</span>
                                        <span>{formatValue(result.gameId)}</span>
                                    </div>

                                    <div className="page6__devRow">
                                        <span>Final Wheel Angle</span>
                                        <span>
                                            {formatAngle(result.finalWheelAngle)}
                                        </span>
                                    </div>

                                    <div className="page6__devRow">
                                        <span>Server Timestamp</span>
                                        <span>
                                            {formatTimestamp(result.serverTimestamp)}
                                        </span>
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
