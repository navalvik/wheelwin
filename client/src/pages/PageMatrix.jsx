import { useState } from "react";

import GameLayout from "../layouts/GameLayout";

import "../styles/pageMatrix.css";

export default function PageMatrix({ onNavigate }) {

    const [secretMatrix, setSecretMatrix] = useState(
        Array(9).fill("")
    );

    function handleMatrixChange(index, rawValue) {

        const symbol = rawValue
            .toUpperCase()
            .replace(/[^A-Z0-9]/g, "")
            .slice(-1);

        setSecretMatrix((prev) => {
            const next = [...prev];
            next[index] = symbol;
            return next;
        });
    }

    const isMatrixComplete = secretMatrix.every((cell) => cell.length === 1);

    return (

        <GameLayout

              message="SECRET MATRIX"

              backEnabled={true}

              onBack={() => onNavigate(3)}

              nextEnabled={isMatrixComplete}

              onNext={() => onNavigate(5)}
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

                </div>

            </div>

        </GameLayout>

    );

}
