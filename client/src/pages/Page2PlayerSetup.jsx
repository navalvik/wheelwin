import { useEffect, useMemo, useState } from "react";

import GameLayout from "../layouts/GameLayout";

import { useGameSession } from "../context/GameSessionContext";
import { useLanguage } from "../context/LanguageContext";
import { usePlayerIdentity } from "../context/PlayerIdentityContext";

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

    const { t } = useLanguage();

    const { identity } = usePlayerIdentity();

    const [nickname, setNickname] = useState(identity?.nickname ?? "");

    const [age, setAge] = useState(identity?.age == null ? "" : String(identity.age));

    const [stake, setStake] = useState(String(identity?.baseStake ?? 1));

    const [sectors, setSectors] = useState(String(identity?.sectorCount ?? 1));

    const [sectorArrangement, setSectorArrangement] = useState(identity?.sectorArrangement ?? "together");

    const [colorSector1, setColorSector1] = useState(identity?.color ?? "Green");

    const [colorSector2, setColorSector2] = useState(identity?.colorSector2 ?? "Blue");

    useEffect(() => {
        const onRoomRecoverySync = (payload) => {
            const profile = payload?.profile;
            if (!profile || payload?.playerId !== identity?.playerId) return;
            if (profile.nickname != null) setNickname(profile.nickname);
            if (profile.age != null) setAge(String(profile.age));
            if (profile.baseStake != null) setStake(String(profile.baseStake));
            if (profile.sectorCount != null) setSectors(String(profile.sectorCount));
            if (profile.sectorArrangement) setSectorArrangement(profile.sectorArrangement);
            if (profile.color) setColorSector1(profile.color);
            if (profile.colorSector2) setColorSector2(profile.colorSector2);
        };
        socket.on("ROOM_RECOVERY_SYNC", onRoomRecoverySync);
        return () => socket.off("ROOM_RECOVERY_SYNC", onRoomRecoverySync);
    }, [identity?.playerId]);

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

                    <div className="setupGroup setupGroup--identity">

                        <div className="identityGrid">

                            <div className="setupField">

                                <label className="setupFieldLabel">

                                    INPUT NICKNAME

                                </label>

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

                            <div className="setupField setupField--age">

                                <label className="setupFieldLabel">

                                    {t("setup.age")}

                                </label>

                                <div className="ageControl">

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

                            </div>

                        </div>

                    </div>

                    <div className="setupGroup">

                        <div className="setupFieldLabel setupGroupLabel">

                            {t("setup.baseStake")}

                        </div>

                        <div className="radioGroup radioGroup--inline">

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

                    <div className="setupGroup">

                        <div className="setupFieldLabel setupGroupLabel">

                            {t("setup.sectors")}

                        </div>

                        <div className="radioGroup radioGroup--inline">

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

                        <div className="setupGroup">

                            <div className="setupFieldLabel setupGroupLabel">

                                {t("setup.arrangement")}

                            </div>

                            <div className="radioGroup radioGroup--inline">

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

                    )}

                    <div className="setupGroup">

                        <div className="setupFieldLabel setupGroupLabel">

                            COLORS FOR SECTORS

                        </div>

                        <div className="colorGrid">

                            <label className="colorField">

                                <span className="colorFieldLabel">

                                    {t("setup.sector1")}

                                </span>

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

                            </label>

                            {sectors === "2" && (

                                <label className="colorField">

                                    <span className="colorFieldLabel">

                                        {t("setup.sector2")}

                                    </span>

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

                                </label>

                            )}

                        </div>

                    </div>

                </div>

            </div>

        </GameLayout>

    );

}
