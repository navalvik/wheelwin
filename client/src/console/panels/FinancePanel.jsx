import { useCallback, useEffect, useRef, useState } from "react";

import { useDeveloperAuth } from "../DeveloperAuthProvider";
import { fetchWalletBalances } from "../developerAuthApi";
import PanelShell from "./shared/PanelShell";

const REFRESH_INTERVAL_MS = 10_000;

function formatGram(nanoValue) {
    if (nanoValue == null || !/^\d+$/.test(String(nanoValue))) return "—";
    const nano = BigInt(nanoValue);
    const whole = nano / 1_000_000_000n;
    const fraction = String(nano % 1_000_000_000n).padStart(9, "0");
    return `${whole}.${fraction} GRAM`;
}

function formatUpdatedAt(value) {
    if (!value) return "—";
    return new Date(value).toLocaleTimeString();
}

export default function FinancePanel({ network }) {
    const { accessToken } = useDeveloperAuth();
    const [snapshot, setSnapshot] = useState(null);
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);
    const requestInFlight = useRef(false);

    const load = useCallback(async () => {
        if (!accessToken || requestInFlight.current) return;
        requestInFlight.current = true;
        setLoading(true);
        try {
            const result = await fetchWalletBalances(accessToken, network);
            setSnapshot(result);
            setError("");
        } catch (requestError) {
            setError(requestError?.message || "Failed to load Owner Wallet balance");
        } finally {
            requestInFlight.current = false;
            setLoading(false);
        }
    }, [accessToken, network]);

    useEffect(() => {
        if (!accessToken) return undefined;
        load();
        const intervalId = window.setInterval(load, REFRESH_INTERVAL_MS);
        return () => {
            window.clearInterval(intervalId);
        };
    }, [accessToken, load]);

    const configured = snapshot?.configured === true;
    const title = `Finance · ${network === "testnet" ? "Testnet" : "Mainnet"}`;

    return (
        <PanelShell
            title={title}
            subtitle="Owner Wallet balance · automatic refresh every 10 seconds"
            actions={(
                <button type="button" onClick={load} disabled={loading}>
                    {loading ? "Updating…" : "Refresh now"}
                </button>
            )}
        >
            {error && <p className="devConsole__envError" role="alert">{error}</p>}
            <div className="devConsole__kvRow">
                <span className="devConsole__kvKey">Network</span>
                <span className="devConsole__kvValue">{network.toUpperCase()}</span>
            </div>
            <div className="devConsole__kvRow">
                <span className="devConsole__kvKey">Owner Wallet</span>
                <span className="devConsole__kvValue devConsole__financeAddress">
                    {configured ? snapshot.ownerWallet : "Not configured for this network"}
                </span>
            </div>
            <div className="devConsole__kvRow">
                <span className="devConsole__kvKey">Balance</span>
                <span className="devConsole__kvValue">
                    {configured ? formatGram(snapshot.balanceNano) : "—"}
                </span>
            </div>
            <div className="devConsole__kvRow">
                <span className="devConsole__kvKey">Account state</span>
                <span className="devConsole__kvValue">
                    {configured ? snapshot.accountState : "—"}
                </span>
            </div>
            <div className="devConsole__kvRow">
                <span className="devConsole__kvKey">Last updated</span>
                <span className="devConsole__kvValue">{formatUpdatedAt(snapshot?.updatedAt)}</span>
            </div>
        </PanelShell>
    );
}
