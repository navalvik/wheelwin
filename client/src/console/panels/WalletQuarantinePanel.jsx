import { useCallback, useEffect, useRef, useState } from "react";
import { useDeveloperAuth } from "../DeveloperAuthProvider";
import { fetchWalletQuarantine, performWalletQuarantineAction } from "../developerAuthApi";
import PanelShell from "./shared/PanelShell";

const REFRESH_MS = 10_000;
function grams(nano) {
    if (nano == null) return "—";
    try {
        const value = BigInt(nano);
        const whole = value / 1_000_000_000n;
        const decimals = (value % 1_000_000_000n).toString().padStart(9,"0")
            .replace(/0+$/,"");
        return `${whole}.${decimals.padEnd(2,"0")} Gram`;
    } catch {return "—";}
}

export default function WalletQuarantinePanel() {
    const {accessToken, isAdministrator} = useDeveloperAuth();
    const [input,setInput] = useState("");
    const [selected,setSelected] = useState(null);
    const [snapshot,setSnapshot] = useState(null);
    const [error,setError] = useState("");
    const [message,setMessage] = useState("");
    const [confirmation,setConfirmation] = useState("");
    const [investigationNote,setInvestigationNote] = useState("");
    const [busy,setBusy] = useState(false);
    const inFlight = useRef(false);
    const load = useCallback(async () => {
        if (!accessToken || !isAdministrator || inFlight.current) return;
        inFlight.current = true;
        try {
            setSnapshot(await fetchWalletQuarantine(accessToken,selected));
            setError("");
        } catch(e) { setError(e.message || "Ошибка запроса кошельков"); }
        finally {inFlight.current=false;}
    },[accessToken,isAdministrator,selected]);

    useEffect(() => {
        if (!accessToken || !isAdministrator) return undefined;
        load();
        const timer = window.setInterval(load,REFRESH_MS);
        return () => window.clearInterval(timer);
    },[accessToken,isAdministrator,load]);

    const choose = (value) => {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1 || n > 64) {
            setError("Введите номер кошелька от 1 до 64");
            return;
        }
        setSelected(n);
        setInput(String(n));
        setConfirmation("");
        setInvestigationNote("");
        setMessage("");
        setError("");
    };

    const action = async (kind) => {
        if (!accessToken || !isAdministrator || !selected || busy) return;
        const expected = kind === "quarantine"
            ? `QUARANTINE ${selected}`
            : kind === "release"
                ? `RELEASE ${selected}`
                : `SWEEP ${selected} TO TON_RESIDUES`;
        if (confirmation !== expected) {
            setError("Введите точную фразу подтверждения");
            return;
        }
        setBusy(true);
        setError("");
        setMessage("");
        try {
            const result = await performWalletQuarantineAction(
                accessToken,kind,selected,confirmation,investigationNote
            );
            setMessage(kind === "quarantine"
                ? `Кошелёк №${selected}: карантин установлен.${result.reservedByRoomId
                    ? " Текущая комната продолжает работу; повторное назначение запрещено."
                    : " Новые назначения запрещены."}`
                : kind === "release"
                    ? `Кошелёк №${selected}: карантин снят.`
                    : `Кошелёк №${selected}: ${result.code ?? "результат неизвестен"}.
Отправка ещё не означает подтверждённое зачисление на TON_RESIDUES.`);
            setConfirmation("");
            if (kind === "quarantine") setInvestigationNote("");
            await load();
        } catch(e) {
            setError(e.message || "Операция отклонена");
            setConfirmation("");
        } finally {setBusy(false);}
    };

    const current = snapshot?.selected;
    const blocked = current?.outstanding?.open > 0 || Boolean(current?.reservedByRoomId);
    const quarantineText = current ? `QUARANTINE ${current.roomNumber}` : "";
    const releaseText = current ? `RELEASE ${current.roomNumber}` : "";
    const sweepText = current ? `SWEEP ${current.roomNumber} TO TON_RESIDUES` : "";

    return (
        <PanelShell title="Карантин кошельков"
            subtitle="Testnet · только администратор · опрос только выбранного кошелька и TON_RESIDUES каждые 10 секунд">
            {!isAdministrator && <p>Необходим вход с ролью Administrator.</p>}
            {error && <p role="alert" style={{color:"#ff8b8b"}}>{error}</p>}
            {message && <p role="status">{message}</p>}
            <section className="devConsole__opsCard">
                <h3>Кошельки в карантине ({snapshot?.quarantined?.length ?? "—"})</h3>
                <p>Карантин запрещает выдачу кошелька новой комнате. Баланс проверяется по выбору.</p>
                {(snapshot?.quarantined ?? []).length === 0 && <p>В карантине нет кошельков.</p>}
                {(snapshot?.quarantined ?? []).map(wallet => (
                    <div className="devConsole__kvRow" key={wallet.roomNumber}>
                        <span className="devConsole__kvKey">
                            №{wallet.roomNumber} · {wallet.reason}
                            {wallet.reservedByRoomId ? ` · активная комната: ${wallet.reservedByRoomId}` : ""}
                            {wallet.quarantineNote ? ` · ${wallet.quarantineNote}` : ""}
                        </span>
                        <button type="button" disabled={busy} onClick={() => choose(wallet.roomNumber)}>
                            Проверить
                        </button>
                    </div>
                ))}
            </section>
            <section className="devConsole__opsCard">
                <h3>Ручной опрос игрового кошелька</h3>
                <form onSubmit={e => {e.preventDefault();choose(input);}}>
                    <label htmlFor="quarantine-wallet-number">Номер кошелька (1–64)</label>
                    {" "}
                    <input id="quarantine-wallet-number" type="number" min="1" max="64"
                        value={input} onChange={e=>setInput(e.target.value)}
                        style={{maxWidth:"110px"}}/>
                    {" "}
                    <button type="submit" disabled={busy}>Показать</button>
                    {" "}
                    <button type="button" disabled={busy} onClick={load}>Обновить</button>
                </form>
                {current && <div className="devConsole__kvList">
                    <div className="devConsole__kvRow"><span>Номер</span><strong>№{current.roomNumber}</strong></div>
                    <div className="devConsole__kvRow"><span>Адрес</span><code style={{overflowWrap:"anywhere"}}>{current.address}</code></div>
                    <div className="devConsole__kvRow"><span>Баланс</span><strong>{grams(current.balanceNano)}</strong></div>
                    <div className="devConsole__kvRow"><span>Карантин</span><strong>{current.quarantined ? "Да" : "Нет"}</strong></div>
                    <div className="devConsole__kvRow"><span>Активная комната</span><span>{current.reservedByRoomId || "Нет"}</span></div>
                    {current.quarantineNote && <div className="devConsole__kvRow"><span>Причина карантина</span>
                        <span>{current.quarantineNote}</span></div>}
                    {current.quarantinedAt && <div className="devConsole__kvRow"><span>Дата карантина</span>
                        <span>{current.quarantinedAt}</span></div>}
                    <div className="devConsole__kvRow"><span>Незавершённые обязательства</span>
                        <strong>{current.outstanding?.open ?? "—"}</strong></div>
                    <div className="devConsole__kvRow"><span>Запись об отправке остатка</span>
                        <span>{current.sweepClaimExists ? "Есть — требуется ручная сверка" : "Нет"}</span></div>
                    <div className="devConsole__kvRow"><span>Время запроса</span><span>{current.updatedAt}</span></div>
                </div>}
            </section>
            <section className="devConsole__opsCard">
                <h3>TON_RESIDUES · серверный кошелёк остатков</h3>
                <div className="devConsole__kvList">
                    <div className="devConsole__kvRow"><span>Адрес</span>
                        <code style={{overflowWrap:"anywhere"}}>{snapshot?.residues?.address || "Не задан TON_RESIDUES_EXPECTED_ADDRESS"}</code>
                    </div>
                    <div className="devConsole__kvRow"><span>Баланс</span>
                        <strong>{grams(snapshot?.residues?.balanceNano)}</strong></div>
                    <div className="devConsole__kvRow"><span>Время запроса</span>
                        <span>{snapshot?.residues?.updatedAt || "—"}</span></div>
                </div>
            </section>
            {current && <section className="devConsole__opsCard">
                <h3>Административные операции · №{current.roomNumber}</h3>
                <p><strong>Поставить в карантин:</strong> разрешено для любого свободного
                    или занятого кошелька. Если комната активна, она продолжит работу,
                    а кошелёк не будет выдан другой комнате после завершения.</p>
                <p><strong>Снять карантин или вывести средства:</strong> нельзя при активной
                    комнате либо незавершённых возвратах/выплатах. При выводе TON
                    удерживает сетевые комиссии из самого кошелька. Повтора нет.</p>
                {blocked && <p role="alert">Снятие карантина и вывод средств заблокированы:
                    есть действующая комната или долги. Постановка на карантин доступна.</p>}
                {!current.quarantined && <label htmlFor="quarantine-note">
                    Причина расследования (необязательно, до 200 символов)
                    <input id="quarantine-note" type="text" maxLength={200}
                        autoComplete="off" value={investigationNote}
                        onChange={e=>setInvestigationNote(e.target.value)}
                        style={{width:"100%",maxWidth:"420px",display:"block"}}/>
                </label>}
                <p>Для освобождения нужен нулевой подтверждённый баланс.
                    После попытки вывода необходима ручная сверка транзакции.
                    Действие не удаляет долгов перед игроками и не подтверждает зачисление.</p>
                <label htmlFor="quarantine-confirmation">Фраза подтверждения:</label>
                <input id="quarantine-confirmation" type="text" autoComplete="off"
                    value={confirmation} onChange={e=>setConfirmation(e.target.value)}
                    style={{width:"100%",maxWidth:"420px",display:"block"}}/>
                <p><code>{quarantineText}</code>, <code>{releaseText}</code> или <code>{sweepText}</code></p>
                <div style={{display:"flex",gap:"10px",flexWrap:"wrap"}}>
                    <button type="button" disabled={busy || current.quarantined
                        || confirmation !== quarantineText}
                        onClick={()=>action("quarantine")}>Поставить в карантин</button>
                    <button type="button" disabled={busy || blocked || !current.quarantined
                        || confirmation !== releaseText}
                        onClick={()=>action("release")}>Освободить из карантина</button>
                    <button type="button" disabled={busy || blocked || !snapshot?.sweepEnabled
                        || current.sweepClaimExists || confirmation !== sweepText}
                        onClick={()=>action("sweep")}>Перевести весь остаток на TON_RESIDUES</button>
                </div>
                {!snapshot?.sweepEnabled && <p>Вывод отключён: требуется явный Testnet-флаг
                    ADMIN_WALLET_SWEEP_ENABLED=true на сервере. Это не связано с запуском Mainnet.</p>}
            </section>}
        </PanelShell>
    );
}
