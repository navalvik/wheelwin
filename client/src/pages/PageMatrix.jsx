import { useEffect, useMemo, useState } from "react";

import GameLayout from "../layouts/GameLayout";

import socket from "../socket/socket";

import {
    isValidSecretMatrix,
    sanitizeSecretMatrixCell
} from "../utils/secretMatrixRules";

import "../styles/pageMatrix.css";

export default function PageMatrix({ onNavigate }) {

    const [secretMatrix, setSecretMatrix] = useState(
        Array(9).fill("")
    );

    const [waitingForMatch, setWaitingForMatch] = useState(false);

    const [errorMessage, setErrorMessage] = useState("");

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

    useEffect(() => {

        function handleAccepted() {

            setWaitingForMatch(false);

            setErrorMessage("");

            onNavigate(5);

        }

        function handleRejected(payload) {

            setWaitingForMatch(false);

            setErrorMessage(
                payload?.message
                    ?? "Secret Matrix was rejected. Try again."
            );

        }

        socket.on("SECRET_MATRIX_ACCEPTED", handleAccepted);

        socket.on("SECRET_MATRIX_REJECTED", handleRejected);

        return () => {

            socket.off("SECRET_MATRIX_ACCEPTED", handleAccepted);

            socket.off("SECRET_MATRIX_REJECTED", handleRejected);

        };

    }, [onNavigate]);

    function handleSubmit() {

        if (!isMatrixValid || waitingForMatch) {

            return;

        }

        setWaitingForMatch(true);

        setErrorMessage("");

        socket.emit("submitSecretMatrix", secretMatrix);

    }

    return (

        <GameLayout

            message="SECRET MATRIX"

            backEnabled={!waitingForMatch}

            onBack={() => onNavigate(3)}

            nextEnabled={isMatrixValid && !waitingForMatch}

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
                                    disabled={waitingForMatch}
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

                    {waitingForMatch && (

                        <p className="matrixInstruction" aria-live="polite">

                            Waiting for all players to submit the same code…

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
