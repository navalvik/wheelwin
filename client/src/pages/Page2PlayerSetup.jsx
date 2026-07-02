import { useState } from "react";

import GameLayout from "../layouts/GameLayout";

import "../styles/page2player.css";

export default function Page2PlayerSetup({ onNavigate }) {

    const [language, setLanguage] = useState("English");

    const [nickname, setNickname] = useState("");

    const [age, setAge] = useState("");

    const [stake, setStake] = useState("1");

    const [sectors, setSectors] = useState("1");

    const [sectorArrangement, setSectorArrangement] = useState("together");

    const [colorSector1, setColorSector1] = useState("Green");

    const [colorSector2, setColorSector2] = useState("Blue");

    return (

        <GameLayout

            message="PLAYER SETUP"

            nextEnabled={true}

            onNext={() => onNavigate(4)}

        >

            <div className="page2">

                <div className="setupPanel">

                    <div className="setupGrid">

                        <div className="setupLabelCell">

                            CHOOSE LANGUAGE

                        </div>

                        <div className="setupControlCell">

                            <select

                                className="setupSelect"

                                value={language}

                                onChange={(e) => setLanguage(e.target.value)}

                            >

                                <option>English</option>
                                <option>Русский</option>

                            </select>

                        </div>

                        <div className="setupLabelCell">

                            INPUT YOUR NICKNAME

                        </div>

                        <div className="setupControlCell">

                            <input

                                className="setupInput setupInput--nickname"

                                type="text"

                                maxLength={4}

                                value={nickname}

                                onChange={(e) =>

                                    setNickname(e.target.value)

                                }

                            />

                        </div>

                        <div className="setupLabelCell">

                            HOW OLD ARE YOU?

                        </div>

                        <div className="setupControlCell setupControlCell--age">

                            <input

                                className="setupInput setupInput--age"

                                type="text"

                                inputMode="numeric"

                                pattern="[0-9]*"

                                value={age}

                                onChange={(e) =>

                                    setAge(e.target.value.replace(/\D/g, ""))

                                }

                            />

                            <div className="ageValidation">

                                You must be between 18 and 99 years old.

                            </div>

                        </div>

                        <div className="setupLabelCell">

                            BASE STAKE

                        </div>

                        <div className="setupControlCell">

                            <div className="radioGroup">

                                <label>

                                    <input

                                        type="radio"

                                        value="1"

                                        checked={stake === "1"}

                                        onChange={(e) =>

                                            setStake(e.target.value)

                                        }

                                    />

                                    1 GRAM

                                </label>

                                <label>

                                    <input

                                        type="radio"

                                        value="10"

                                        checked={stake === "10"}

                                        onChange={(e) =>

                                            setStake(e.target.value)

                                        }

                                    />

                                    10 GRAM

                                </label>

                            </div>

                        </div>

                        <div className="setupLabelCell">

                            SECTORS

                        </div>

                        <div className="setupControlCell">

                            <div className="radioGroup">

                                <label>

                                    <input

                                        type="radio"

                                        value="1"

                                        checked={sectors === "1"}

                                        onChange={(e) =>

                                            setSectors(e.target.value)

                                        }

                                    />

                                    1 SECTOR

                                </label>

                                <label>

                                    <input

                                        type="radio"

                                        value="2"

                                        checked={sectors === "2"}

                                        onChange={(e) =>

                                            setSectors(e.target.value)

                                        }

                                    />

                                    2 SECTORS

                                </label>

                            </div>

                        </div>

                        {sectors === "2" && (

                            <>

                                <div className="setupLabelCell">

                                    ARRANGEMENT

                                </div>

                                <div className="setupControlCell">

                                    <div className="radioGroup">

                                        <label>

                                            <input

                                                type="radio"

                                                value="together"

                                                checked={sectorArrangement === "together"}

                                                onChange={(e) =>

                                                    setSectorArrangement(e.target.value)

                                                }

                                            />

                                            TOGETHER

                                        </label>

                                        <label>

                                            <input

                                                type="radio"

                                                value="separate"

                                                checked={sectorArrangement === "separate"}

                                                onChange={(e) =>

                                                    setSectorArrangement(e.target.value)

                                                }

                                            />

                                            SEPARATE

                                        </label>

                                    </div>

                                </div>

                            </>

                        )}

                        <div className="setupLabelCell">

                            COLOR FOR SECTOR 1

                        </div>

                        <div className="setupControlCell">

                            <select

                                className="setupSelect setupSelect--color"

                                value={colorSector1}

                                onChange={(e) => setColorSector1(e.target.value)}

                            >

                                <option value="Green">Green</option>
                                <option value="Blue">Blue</option>
                                <option value="Red">Red</option>

                            </select>

                        </div>

                        {sectors === "2" && (

                            <>

                                <div className="setupLabelCell">

                                    COLOR FOR SECTOR 2

                                </div>

                                <div className="setupControlCell">

                                    <select

                                        className="setupSelect setupSelect--color"

                                        value={colorSector2}

                                        onChange={(e) => setColorSector2(e.target.value)}

                                    >

                                        <option value="Green">Green</option>
                                        <option value="Blue">Blue</option>
                                        <option value="Red">Red</option>

                                    </select>

                                </div>

                            </>

                        )}

                    </div>

                </div>

            </div>

        </GameLayout>

    );

}
