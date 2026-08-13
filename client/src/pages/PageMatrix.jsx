import { useEffect, useMemo, useRef, useState } from "react";

import GameLayout from "../layouts/GameLayout";

import { useLanguage } from "../context/LanguageContext";

import socket from "../socket/socket";

import {
    isValidSecretMatrix,
    sanitizeSecretMatrixCell
} from "../utils/secretMatrixRules";

import {
    SECRET_MATRIX_STATUS,
    SECRET_MATRIX_STATUS_REASONS,
    canSubmitMatrixStatus,
    createEmptyMatrixStatus
} from "../utils/secretMatrixStatus";

import "../styles/pageMatrix.css";

export default function PageMatrix({ onNavigate }) {

    const { t } = useLanguage();

    const [secretMatrix, setSecretMatrix] = useState(
        Array(9).fill("")
    );

    const [matrixStatus, setMatrixStatus] = useState(createEmptyMatrixStatus);

    const [errorMessage, setErrorMessage] = useState("");

    const revisionRef = useRef(0);

    function handleMatrixChange(index, rawValue) {

        const symbol = sanitizeSecretMatrixCell(rawValue);

        setSecretMatrix((prev) => {

            const next = [...prev];

            next[index] = symbol;

            return next;

        });

        setErrorMessage("");

    }

    const isMatrixValid = useMemo(
        () => isValidSecretMatrix(secretMatrix),
        [secretMatrix]
    );

    const canSubmit = canSubmitMatrixStatus(matrixStatus.status);

    const isWaiting = matrixStatus.status === SECRET_MATRIX_STATUS.SUBMITTED
        || matrixStatus.status === SECRET_MATRIX_STATUS.MATCH_ACCEPTED;

    useEffect(() => {

        function applyStatus(payload) {

            const revision = Number(payload?.revision ?? 0);

            if (revision > 0 && revision <= revisionRef.current) {

                return;

            }

            if (revision > 0) {

                revisionRef.current = revision;

            }

            const nextStatus = {
                status: payload?.status
                    ?? SECRET_MATRIX_STATUS.NOT_SUBMITTED,
                submittedCount: Number(payload?.submittedCount ?? 0),
                requiredPlayers: Number(payload?.requiredPlayers ?? 0),
                selfSubmitted: payload?.selfSubmitted === true,
                reason: payload?.reason ?? null,
                revision
            };

            setMatrixStatus(nextStatus);

            if (typeof console !== "undefined") {

                console.info(
                    "[SECRET_MATRIX_STATUS_RECEIVED]",
                    nextStatus
                );

            }

            if (nextStatus.status === SECRET_MATRIX_STATUS.MATCH_ACCEPTED) {

                setErrorMessage("");

                onNavigate(5);

                return;

            }

            if (
                nextStatus.reason
                    === SECRET_MATRIX_STATUS_REASONS.SOCKET_NOT_AUTHORIZED
            ) {

                setErrorMessage(
                    t("matrix.connectionRestored")
                );

                return;

            }

            if (
                nextStatus.status === SECRET_MATRIX_STATUS.MATCH_REJECTED
                || nextStatus.reason
                    === SECRET_MATRIX_STATUS_REASONS.SECRET_MATRIX_MISMATCH
            ) {

                setErrorMessage(
                    t("matrix.mismatch")
                );

                return;

            }

            if (
                nextStatus.reason
                    === SECRET_MATRIX_STATUS_REASONS.INVALID_SECRET_MATRIX
            ) {

                setErrorMessage(
                    t("matrix.incomplete")
                );

            }

        }

        function handleAccepted() {

            setErrorMessage("");

            onNavigate(5);

        }

        function handleRejected(payload) {

            setErrorMessage(
                payload?.message
                    ?? t("matrix.rejected")
            );

        }

        socket.on("SECRET_MATRIX_STATUS", applyStatus);

        socket.on("SECRET_MATRIX_ACCEPTED", handleAccepted);

        socket.on("SECRET_MATRIX_REJECTED", handleRejected);

        return () => {

            socket.off("SECRET_MATRIX_STATUS", applyStatus);

            socket.off("SECRET_MATRIX_ACCEPTED", handleAccepted);

            socket.off("SECRET_MATRIX_REJECTED", handleRejected);

        };

    }, [onNavigate, t]);

    function handleSubmit() {

        if (!isMatrixValid || !canSubmit) {

            return;

        }

        setErrorMessage("");

        socket.emit("submitSecretMatrix", secretMatrix);

    }

    const waitingLabel = matrixStatus.requiredPlayers > 0
        ? t("matrix.waitingCount", {
            submitted: matrixStatus.submittedCount,
            required: matrixStatus.requiredPlayers
        })
        : t("matrix.waitingAll");

    return (

        <GameLayout

            message={t("page.matrix.title")}

            backEnabled={canSubmit}

            onBack={() => onNavigate(3)}

            nextEnabled={isMatrixValid && canSubmit}

            onNext={handleSubmit}
        >

            <div className="pageMatrix">

                <div className="matrixPanel">

                    <h1 className="matrixTitle">

                        {t("matrix.title")}

                    </h1>

                    <p className="matrixInstruction">

                        {t("matrix.instruction")}

                    </p>

                    <div className="matrixSection">

                        <div className="matrix">

                            {secretMatrix.map((value, index) => (

                                <input
                                    key={index}
                                    className="matrixCell"
                                    type="text"
                                    inputMode="text"
                                    autoComplete="off"
                                    autoCorrect="off"
                                    spellCheck={false}
                                    maxLength={1}
                                    value={value}
                                    disabled={isWaiting}
                                    onChange={(e) =>
                                        handleMatrixChange(index, e.target.value)
                                    }
                                />

                            ))}

                        </div>

                        <div className="matrixText">

                            {t("matrix.sideHint").split("\n").map((line, index, lines) => (

                                <span key={`matrix-hint-${index}`}>

                                    {line}

                                    {index < lines.length - 1 ? <br /> : null}

                                </span>

                            ))}

                        </div>

                    </div>

                    {isWaiting && (

                        <p className="matrixInstruction" aria-live="polite">

                            {waitingLabel}

                        </p>

                    )}

                    {errorMessage && (

                        <p className="matrixInstruction" aria-live="assertive">

                            {errorMessage}

                        </p>

                    )}

                </div>

            </div>

        </GameLayout>

    );

}
