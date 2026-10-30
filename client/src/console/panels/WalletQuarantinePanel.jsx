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
        } catch(e) { setError(e.message || "Failed to retrieve wallet information"); }
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
            setError("Enter a wallet number from 1 to 64");
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
            setError("Enter the exact confirmation phrase");
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
                ? `Wallet #${selected}: quarantine enabled.${result.reservedByRoomId
                    ? " The active room continues running; wallet reassignment is blocked."
                    : " New room assignments are blocked."}`
                : kind === "release"
                    ? `Wallet #${selected}: quarantine released.`
                    : `Wallet #${selected}: ${result.code ?? "unknown result"}.
Submission does not confirm that funds were received by TON_RESIDUES.`);
            setConfirmation("");
            if (kind === "quarantine") setInvestigationNote("");
            await load();
        } catch(e) {
            setError(e.message || "Operation rejected");
            setConfirmation("");
        } finally {setBusy(false);}
    };

    const current = snapshot?.selected;
    const blocked = current?.outstanding?.open > 0 || Boolean(current?.reservedByRoomId);
    const quarantineText = current ? `QUARANTINE ${current.roomNumber}` : "";
    const releaseText = current ? `RELEASE ${current.roomNumber}` : "";
    const sweepText = current ? `SWEEP ${current.roomNumber} TO TON_RESIDUES` : "";

    return (
        <PanelShell title="Wallet Quarantine"
            subtitle="Testnet · administrators only · selected wallet and TON_RESIDUES refreshed every 10 seconds">
            {!isAdministrator && <p>Administrator access is required.</p>}
            {error && <p role="alert" style={{color:"#ff8b8b"}}>{error}</p>}
            {message && <p role="status">{message}</p>}
            <section className="devConsole__opsCard">
                <h3>Quarantined Wallets ({snapshot?.quarantined?.length ?? "—"})</h3>
                <p>Quarantine prevents assignment to new rooms. Balance is checked only for the selected wallet.</p>
                {(snapshot?.quarantined ?? []).length === 0 && <p>No wallets are quarantined.</p>}
                {(snapshot?.quarantined ?? []).map(wallet => (
                    <div className="devConsole__kvRow" key={wallet.roomNumber}>
                        <span className="devConsole__kvKey">
                            #{wallet.roomNumber} · {wallet.reason}
                            {wallet.reservedByRoomId ? ` · active room: ${wallet.reservedByRoomId}` : ""}
                            {wallet.quarantineNote ? ` · ${wallet.quarantineNote}` : ""}
                        </span>
                        <button type="button" disabled={busy} onClick={() => choose(wallet.roomNumber)}>
                            Inspect
                        </button>
                    </div>
                ))}
            </section>
            <section className="devConsole__opsCard">
                <h3>Manual Room Wallet Lookup</h3>
                <form onSubmit={e => {e.preventDefault();choose(input);}}>
                    <label htmlFor="quarantine-wallet-number">Wallet Number (1–64)</label>
                    {" "}
                    <input id="quarantine-wallet-number" type="number" min="1" max="64"
                        value={input} onChange={e=>setInput(e.target.value)}
                        style={{maxWidth:"110px"}}/>
                    {" "}
                    <button type="submit" disabled={busy}>Show</button>
                    {" "}
                    <button type="button" disabled={busy} onClick={load}>Refresh</button>
                </form>
                {current && <div className="devConsole__kvList">
                    <div className="devConsole__kvRow"><span>Number</span><strong>#{current.roomNumber}</strong></div>
                    <div className="devConsole__kvRow"><span>Address</span><code style={{overflowWrap:"anywhere"}}>{current.address}</code></div>
                    <div className="devConsole__kvRow"><span>Balance</span><strong>{grams(current.balanceNano)}</strong></div>
                    <div className="devConsole__kvRow"><span>Quarantined</span><strong>{current.quarantined ? "Yes" : "No"}</strong></div>
                    <div className="devConsole__kvRow"><span>Active Room</span><span>{current.reservedByRoomId || "No"}</span></div>
                    {current.quarantineNote && <div className="devConsole__kvRow"><span>Quarantine Reason</span>
                        <span>{current.quarantineNote}</span></div>}
                    {current.quarantinedAt && <div className="devConsole__kvRow"><span>Quarantined At</span>
                        <span>{current.quarantinedAt}</span></div>}
                    <div className="devConsole__kvRow"><span>Outstanding Obligations</span>
                        <strong>{current.outstanding?.open ?? "—"}</strong></div>
                    <div className="devConsole__kvRow"><span>Residual Sweep Record</span>
                        <span>{current.sweepClaimExists ? "Exists — manual reconciliation required" : "No"}</span></div>
                    <div className="devConsole__kvRow"><span>Last Checked</span><span>{current.updatedAt}</span></div>
                </div>}
            </section>
            <section className="devConsole__opsCard">
                <h3>TON_RESIDUES · residual funds server wallet</h3>
                <div className="devConsole__kvList">
                    <div className="devConsole__kvRow"><span>Address</span>
                        <code style={{overflowWrap:"anywhere"}}>{snapshot?.residues?.address || "TON_RESIDUES_EXPECTED_ADDRESS not configured"}</code>
                    </div>
                    <div className="devConsole__kvRow"><span>Balance</span>
                        <strong>{grams(snapshot?.residues?.balanceNano)}</strong></div>
                    <div className="devConsole__kvRow"><span>Last Checked</span>
                        <span>{snapshot?.residues?.updatedAt || "—"}</span></div>
                </div>
            </section>
            {current && <section className="devConsole__opsCard">
                <h3>Administrative Actions · #{current.roomNumber}</h3>
                <p><strong>Quarantine wallet:</strong> allowed for both available and reserved wallets. An active room may finish normally;
                    the quarantined wallet will not be assigned to another room.</p>
                <p><strong>Release quarantine or sweep funds:</strong> blocked while the room is active or refunds/payouts remain outstanding. TON network fees
                    are paid from the source wallet balance. Sweeps are not automatically retried.</p>
                {blocked && <p role="alert">Quarantine release and fund sweep are blocked while a room is active
                    or financial obligations remain. Quarantine is still available.</p>}
                {!current.quarantined && <label htmlFor="quarantine-note">
                    Investigation note (optional, up to 200 characters)
                    <input id="quarantine-note" type="text" maxLength={200}
                        autoComplete="off" value={investigationNote}
                        onChange={e=>setInvestigationNote(e.target.value)}
                        style={{width:"100%",maxWidth:"420px",display:"block"}}/>
                </label>}
                <p>Quarantine release requires a confirmed zero balance.
                    Manually reconcile the on-chain transaction after a sweep attempt.
                    These actions do not erase player obligations or prove fund receipt.</p>
                <label htmlFor="quarantine-confirmation">Confirmation phrase:</label>
                <input id="quarantine-confirmation" type="text" autoComplete="off"
                    value={confirmation} onChange={e=>setConfirmation(e.target.value)}
                    style={{width:"100%",maxWidth:"420px",display:"block"}}/>
                <p><code>{quarantineText}</code>, <code>{releaseText}</code> or <code>{sweepText}</code></p>
                <div style={{display:"flex",gap:"10px",flexWrap:"wrap"}}>
                    <button type="button" disabled={busy || current.quarantined
                        || confirmation !== quarantineText}
                        onClick={()=>action("quarantine")}>Quarantine Wallet</button>
                    <button type="button" disabled={busy || blocked || !current.quarantined
                        || confirmation !== releaseText}
                        onClick={()=>action("release")}>Release Quarantine</button>
                    <button type="button" disabled={busy || blocked || !snapshot?.sweepEnabled
                        || current.sweepClaimExists || confirmation !== sweepText}
                        onClick={()=>action("sweep")}>Sweep Entire Balance to TON_RESIDUES</button>
                </div>
                {!snapshot?.sweepEnabled && <p>Sweep disabled: explicitly set ADMIN_WALLET_SWEEP_ENABLED=true for Testnet
                    on the server. This is independent of Mainnet activation.</p>}
            </section>}
        </PanelShell>
    );
}
