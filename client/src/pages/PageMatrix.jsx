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
                    "Connection restored. Press NEXT again to submit."
                );

                return;

            }

            if (
                nextStatus.status === SECRET_MATRIX_STATUS.MATCH_REJECTED
                || nextStatus.reason
                    === SECRET_MATRIX_STATUS_REASONS.SECRET_MATRIX_MISMATCH
            ) {

                setErrorMessage(
                    "Secret Matrix codes do not match. Try again."
                );

                return;

            }

            if (
                nextStatus.reason
                    === SECRET_MATRIX_STATUS_REASONS.INVALID_SECRET_MATRIX
            ) {

                setErrorMessage(
                    "Enter a complete Secret Matrix using A–Z and 0–9 only."
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
                    ?? "Secret Matrix was rejected. Try again."
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

    }, [onNavigate]);

    function handleSubmit() {

        if (!isMatrixValid || !canSubmit) {

            return;

        }

        setErrorMessage("");

        socket.emit("submitSecretMatrix", secretMatrix);

    }

    const waitingLabel = matrixStatus.requiredPlayers > 0
        ? `Waiting for players… ${matrixStatus.submittedCount}/${matrixStatus.requiredPlayers}`
        : "Waiting for all players to submit the same code…";

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

                        Secret Matrix

                    </h1>

                    <p className="matrixInstruction">

                        Each player enters a private secret code in the 3×3
                        matrix below. Use letters A–Z and digits 0–9.
                        All three players must enter the same code.

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

                            INPUT YOUR SECRET CODE.

                            <br />

                            <br />

                            YOUR OTHER TWO FRIENDS

                            <br />

                            MUST INPUT SAME.

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
