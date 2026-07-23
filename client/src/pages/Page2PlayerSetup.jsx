import { useMemo, useState } from "react";

import GameLayout from "../layouts/GameLayout";

import { useGameSession } from "../context/GameSessionContext";
import { useLanguage } from "../context/LanguageContext";

import socket from "../socket/socket";

import {
    calculatePaymentGram,
    isValidPlayerAge,
    MAX_PLAYER_AGE,
    MIN_PLAYER_AGE
} from "../utils/playerProfileRules";

import { SECTOR_COLOR_OPTIONS } from "../utils/sectorColors";

import "../styles/page2player.css";

export default function Page2PlayerSetup({ onNavigate }) {

    const { setFinance } = useGameSession();

    const { languageLabel, t } = useLanguage();

    const [nickname, setNickname] = useState("");

    const [age, setAge] = useState("");

    const [stake, setStake] = useState("1");

    const [sectors, setSectors] = useState("1");

    const [sectorArrangement, setSectorArrangement] = useState("together");

    const [colorSector1, setColorSector1] = useState("Green");

    const [colorSector2, setColorSector2] = useState("Blue");

    const ageValid = useMemo(() => isValidPlayerAge(age), [age]);

    function handleContinue() {

        if (!ageValid) {

            return;

        }

        const baseStake = Number(stake);

        setFinance({
            baseStake,
            paymentGram: calculatePaymentGram(baseStake, Number(sectors))
        });

        socket.emit("updatePlayerProfile", {
            nickname: nickname.trim().slice(0, 4),
            age: Number(age),
            baseStake,
            sectorCount: Number(sectors),
            sectorArrangement: sectors === "2" ? sectorArrangement : "together",
            color: colorSector1,
            colorSector2: sectors === "2" ? colorSector2 : null
        });

        onNavigate(4);

    }

    return (

        <GameLayout

            message={t("page.setup.title")}

            nextEnabled={ageValid}

            onNext={handleContinue}

        >

            <div className="page2">

                <div className="setupPanel">

                    <div className="setupGrid">

                        <div className="setupLabelCell">

                            {t("setup.yourLanguage")}

                        </div>

                        <div className="setupControlCell">

                            <div
                                className="setupLanguageValue"
                                aria-readonly="true"
                            >

                                {languageLabel}

                            </div>

                        </div>

                        <div className="setupLabelCell">

                            {t("setup.nickname")}

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

                            {t("setup.age")}

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

                                {t("setup.ageHint", {
                                    min: MIN_PLAYER_AGE,
                                    max: MAX_PLAYER_AGE
                                })}

                            </div>

                        </div>

                        <div className="setupLabelCell">

                            {t("setup.baseStake")}

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

                                    {t("setup.oneGram")}

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

                                    {t("setup.tenGram")}

                                </label>

                            </div>

                        </div>

                        <div className="setupLabelCell">

                            {t("setup.sectors")}

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

                                    {t("setup.oneSector")}

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

                                    {t("setup.twoSectors")}

                                </label>

                            </div>

                        </div>

                        {sectors === "2" && (

                            <>

                                <div className="setupLabelCell">

                                    {t("setup.arrangement")}

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

                                            {t("setup.together")}

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

                                            {t("setup.separate")}

                                        </label>

                                    </div>

                                </div>

                            </>

                        )}

                        <div className="setupLabelCell">

                            {t("setup.colorSector1")}

                        </div>

                        <div className="setupControlCell">

                            <select

                                className="setupSelect setupSelect--color"

                                value={colorSector1}

                                onChange={(e) => setColorSector1(e.target.value)}

                            >

                                {SECTOR_COLOR_OPTIONS.map((color) => (

                                    <option key={color} value={color}>

                                        {color}

                                    </option>

                                ))}

                            </select>

                        </div>

                        {sectors === "2" && (

                            <>

                                <div className="setupLabelCell">

                                    {t("setup.colorSector2")}

                                </div>

                                <div className="setupControlCell">

                                    <select
                                        className="setupSelect setupSelect--color"

                                        value={colorSector2}

                                        onChange={(e) => setColorSector2(e.target.value)}

                                    >

                                        {SECTOR_COLOR_OPTIONS.map((color) => (

                                            <option key={color} value={color}>

                                                {color}

                                            </option>

                                        ))}

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
