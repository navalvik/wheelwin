import { useEffect, useState } from "react";
import GameLayout from "../layouts/GameLayout";
import { useLanguage } from "../context/LanguageContext";
import { useGameSession } from "../context/GameSessionContext";
import { usePlayerIdentity } from "../context/PlayerIdentityContext";
import { LOBBY_OUTGOING_EVENTS } from "../socket/socketEvents";
import { SECTOR_COLOR_OPTIONS } from "../utils/sectorColors";
import socket from "../socket/socket";
import "../styles/noFriends.css";

export default function NoFriendsOptionsPage() {

    const { t } = useLanguage();
    const { setFinance } = useGameSession();
    const { identity } = usePlayerIdentity();
    const [sectors, setSectors] = useState(String(identity?.sectorCount ?? 1));
    const [arrangement, setArrangement] = useState(identity?.sectorArrangement ?? "together");
    const [color, setColor] = useState(identity?.color ?? "Green");
    const [color2, setColor2] = useState(identity?.colorSector2 ?? "Blue");
    const [ready, setReady] = useState(identity?.optionsReady
        ? { readyCount: identity.readyCount ?? 1, required: 3 }
        : null);
    const [submitted, setSubmitted] = useState(identity?.optionsReady === true);
    const profileReady = Boolean(
        identity?.nickname
        && Number.isInteger(Number(identity?.age))
        && Number(identity?.baseStake) > 0
    );

    useEffect(() => {
        const onReady = (payload) => setReady(payload);
        const restoreOptions = (payload) => {
            if (payload?.sectorCount != null) setSectors(String(payload.sectorCount));
            if (payload?.sectorArrangement) setArrangement(payload.sectorArrangement);
            if (payload?.color) setColor(payload.color);
            if (payload?.colorSector2) setColor2(payload.colorSector2);
            if (payload?.optionsReady) {
                setSubmitted(true);
                setReady({ readyCount: payload.readyCount ?? 1, required: 3 });
            } else {
                setSubmitted(false);
                setReady(null);
            }
        };
        const onMatched = restoreOptions;
        const onRecovery = (payload) => restoreOptions({
            ...payload?.profile,
            optionsReady: payload?.optionsReady,
            readyCount: payload?.readyCount
        });
        socket.on("noFriendsOptionsReady", onReady);
        socket.on("noFriendsMatched", onMatched);
        socket.on("ROOM_RECOVERY_SYNC", onRecovery);
        return () => {
            socket.off("noFriendsOptionsReady", onReady);
            socket.off("noFriendsMatched", onMatched);
            socket.off("ROOM_RECOVERY_SYNC", onRecovery);
        };
    }, []);

    function submit() {
        if (submitted || !profileReady) return;
        const stake = Number(identity?.baseStake ?? 1);
        setFinance({ baseStake: stake, paymentGram: stake * (sectors === "2" ? 2.5 : 1) });
        socket.emit(LOBBY_OUTGOING_EVENTS.NO_FRIENDS_OPTIONS_NEXT, {
            nickname: identity?.nickname ?? "",
            age: Number(identity?.age),
            baseStake: stake,
            sectorCount: Number(sectors),
            sectorArrangement: sectors === "2" ? arrangement : "together",
            color,
            colorSector2: sectors === "2" ? color2 : null
        });
        setSubmitted(true);
    }

    const colorOptions = SECTOR_COLOR_OPTIONS.map((option) => typeof option === "string"
        ? { value: option, label: t(`noFriends.color.${option}`) }
        : { value: option.value ?? option.name, label: t(option.labelKey) || option.label || option.name });

    return <GameLayout
        message={t("noFriends.optionsTitle")}
        nextEnabled={!submitted && profileReady}
        nextLabel={t("common.next")}
        onNext={submit}
        showNextButton={!submitted}
    >
        <div className="noFriendsPage">
            <div className="noFriendsForm">
                <div className="noFriendsStatus">{t("noFriends.player", { nickname: identity?.nickname ?? "" })}</div>
                {!profileReady && <div className="noFriendsWaiting">{t("noFriends.loadingProfile")}</div>}
                <label>{t("setup.sectors")}
                    <select value={sectors} onChange={(event) => setSectors(event.target.value)} disabled={submitted}>
                        <option value="1">{t("setup.oneSector")}</option>
                        <option value="2">{t("setup.twoSectors")}</option>
                    </select>
                </label>
                {sectors === "2" && <label>{t("setup.arrangement")}
                    <select value={arrangement} onChange={(event) => setArrangement(event.target.value)} disabled={submitted}>
                        <option value="together">{t("setup.together")}</option>
                        <option value="separate">{t("setup.separate")}</option>
                    </select>
                </label>}
                <label>{t("setup.colorSector1")}
                    <select value={color} onChange={(event) => setColor(event.target.value)} disabled={submitted}>
                        {colorOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                </label>
                {sectors === "2" && <label>{t("setup.colorSector2")}
                    <select value={color2} onChange={(event) => setColor2(event.target.value)} disabled={submitted}>
                        {colorOptions.filter((option) => option.value !== color).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                </label>}
                {submitted && <div className="noFriendsWaiting">{t("noFriends.waitingOptions", { count: ready?.readyCount ?? 1 })}</div>}
            </div>
        </div>
    </GameLayout>;

}
