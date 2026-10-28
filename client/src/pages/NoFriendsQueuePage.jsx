import { useEffect, useState } from "react";
import GameLayout from "../layouts/GameLayout";
import { useLanguage } from "../context/LanguageContext";
import { APP_PAGES } from "../game/sessionRecovery/recoveryFlow";
import { LOBBY_OUTGOING_EVENTS } from "../socket/socketEvents";
import socket from "../socket/socket";
import { MIN_PLAYER_AGE, MAX_PLAYER_AGE } from "../utils/playerProfileRules";
import "../styles/noFriends.css";

export default function NoFriendsQueuePage({ onNavigate, onBack }) {

    const { t } = useLanguage();
    const [nickname, setNickname] = useState("");
    const [age, setAge] = useState("");
    const [baseStake, setBaseStake] = useState("1");
    const [wallet, setWallet] = useState("");
    const [waiting, setWaiting] = useState(null);
    const [checking, setChecking] = useState(false);
    const [error, setError] = useState("");
    const [seconds, setSeconds] = useState(180);

    useEffect(() => {
        const onStatus = (payload) => {
            setChecking(false);
            setWaiting(payload);
            setSeconds(Math.max(0, Math.ceil((payload.expiresAt - Date.now()) / 1000)));
            setError("");
        };
        const onMatched = () => onNavigate(APP_PAGES.NO_FRIENDS_OPTIONS);
        const onExpired = () => {
            setChecking(false);
            setWaiting(null);
            onNavigate(APP_PAGES.WELCOME);
        };
        const onError = (payload) => {
            setChecking(false);
            const message = t(`noFriends.error.${payload?.code ?? "UNKNOWN"}`);
            const detail = typeof payload?.detail === "string"
                ? payload.detail.trim().slice(0, 180)
                : "";
            setError(detail ? `${message} (${detail})` : message);
        };
        const onDisconnect = () => {
            setChecking(false);
            setError(t("noFriends.error.CONNECTION_LOST"));
        };
        socket.on("noFriendsQueueStatus", onStatus);
        socket.on("noFriendsMatched", onMatched);
        socket.on("noFriendsQueueExpired", onExpired);
        socket.on("noFriendsError", onError);
        socket.on("disconnect", onDisconnect);
        return () => {
            socket.off("noFriendsQueueStatus", onStatus);
            socket.off("noFriendsMatched", onMatched);
            socket.off("noFriendsQueueExpired", onExpired);
            socket.off("noFriendsError", onError);
            socket.off("disconnect", onDisconnect);
        };
    }, [onNavigate, t]);

    useEffect(() => {
        if (!waiting) return undefined;
        const interval = setInterval(() => {
            const remaining = Math.max(0, Math.ceil((waiting.expiresAt - Date.now()) / 1000));
            setSeconds(remaining);
        }, 1000);
        return () => clearInterval(interval);
    }, [waiting, onNavigate]);

    function submit() {
        const numericAge = Number(age);
        if (!nickname.trim() || !Number.isInteger(numericAge)
            || numericAge < MIN_PLAYER_AGE || numericAge > MAX_PLAYER_AGE
            || !wallet.trim() || checking || waiting) return;
        setError("");
        setChecking(true);
        socket.emit(LOBBY_OUTGOING_EVENTS.NO_FRIENDS_REQUEST, {
            nickname: nickname.trim().slice(0, 4),
            age: numericAge,
            baseStake: Number(baseStake),
            wallet: wallet.trim(),
            network: "testnet"
        });
    }

    const valid = nickname.trim().length > 0
        && Number.isInteger(Number(age))
        && Number(age) >= MIN_PLAYER_AGE
        && Number(age) <= MAX_PLAYER_AGE
        && wallet.trim().length > 0;

    return <GameLayout
        message={t("noFriends.queueTitle")}
        backEnabled={!waiting && !checking}
        onBack={onBack}
        nextEnabled={!waiting && !checking && valid}
        nextLabel={t("noFriends.findGame")}
        onNext={submit}
    >
        <div className="noFriendsPage">
            <div className="noFriendsForm">
                <label>{t("noFriends.baseStake")}
                    <select value={baseStake} onChange={(event) => setBaseStake(event.target.value)} disabled={Boolean(waiting)}>
                        <option value="1">{t("setup.oneGram")}</option>
                        <option value="10">{t("setup.tenGram")}</option>
                    </select>
                </label>
                <div className="noFriendsNetwork">{t("noFriends.testnetOnly")}</div>
                <label>{t("setup.nickname")}
                    <input maxLength={4} value={nickname} onChange={(event) => setNickname(event.target.value)} disabled={Boolean(waiting)} />
                </label>
                <label>{t("setup.age")}
                    <input inputMode="numeric" value={age} onChange={(event) => setAge(event.target.value.replace(/\D/g, ""))} disabled={Boolean(waiting)} />
                </label>
                <label>{t("noFriends.wallet")}
                    <input autoComplete="off" value={wallet} onChange={(event) => setWallet(event.target.value)} disabled={Boolean(waiting)} />
                </label>
                {waiting && <div className="noFriendsWaiting">
                    {t("noFriends.waiting", { count: waiting.waitingFor })}<br />
                    {t("noFriends.timeLeft", { time: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` })}
                </div>}
                {checking && <div className="noFriendsWaiting">{t("noFriends.checkingWallet")}</div>}
                {error && <div className="noFriendsError">{error}</div>}
            </div>
        </div>
    </GameLayout>;

}
