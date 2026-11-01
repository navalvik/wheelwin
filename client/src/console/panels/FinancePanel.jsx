import { useCallback, useEffect, useRef, useState } from "react";

import { useDeveloperAuth } from "../DeveloperAuthProvider";
import { fetchFinancialObligations, fetchWalletBalances } from "../developerAuthApi";
import PanelShell from "./shared/PanelShell";

const REFRESH_INTERVAL_MS = 10_000;
const OBLIGATIONS_REFRESH_INTERVAL_MS = 30_000;

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
    const [obligations, setObligations] = useState(null);
    const [obligationsError, setObligationsError] = useState("");
    const [obligationsLoading, setObligationsLoading] = useState(false);
    const obligationsRequestInFlight = useRef(false);

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

    const loadObligations = useCallback(async () => {
        if (!accessToken || network !== "testnet" || obligationsRequestInFlight.current) return;
        obligationsRequestInFlight.current = true;
        setObligationsLoading(true);
        try {
            setObligations(await fetchFinancialObligations(accessToken));
            setObligationsError("");
        } catch (requestError) {
            setObligationsError(requestError?.message || "Failed to load financial obligations");
        } finally {
            obligationsRequestInFlight.current = false;
            setObligationsLoading(false);
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

    useEffect(() => {
        if (!accessToken || network !== "testnet") return undefined;
        loadObligations();
        const intervalId = window.setInterval(loadObligations, OBLIGATIONS_REFRESH_INTERVAL_MS);
        return () => window.clearInterval(intervalId);
    }, [accessToken, loadObligations, network]);

    const configured = snapshot?.configured === true;
    const title = `Finance · ${network === "testnet" ? "Testnet" : "Mainnet"}`;

    return (
        <PanelShell
            title={title}
            subtitle="Owner Wallet balance · automatic refresh every 10 seconds"
            actions={(
                <button
                    type="button"
                    onClick={() => {
                        load();
                        loadObligations();
                    }}
                    disabled={loading || (network === "testnet" && obligationsLoading)}
                >
                    {loading || obligationsLoading ? "Updating…" : "Refresh now"}
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
            {network === "testnet" && (
                <section aria-labelledby="financial-obligations-title">
                    <h3 id="financial-obligations-title" className="devConsole__sectionTitle">
                        Financial Obligations — Read Only
                    </h3>
                    {obligationsError && (
                        <p className="devConsole__envError" role="alert">{obligationsError}</p>
                    )}
                    {obligationsLoading && !obligations && <p>Loading financial obligations…</p>}
                    {obligations && (
                        <>
                            <div className="devConsole__kvRow">
                                <span className="devConsole__kvKey">Unsettled obligations</span>
                                <span className="devConsole__kvValue">{obligations.unsettledCount}</span>
                            </div>
                            <div className="devConsole__kvRow">
                                <span className="devConsole__kvKey">Rooms scanned</span>
                                <span className="devConsole__kvValue">
                                    {obligations.roomsScanned} ({obligations.closedRoomsScanned} closed)
                                </span>
                            </div>
                            <div className="devConsole__kvRow">
                                <span className="devConsole__kvKey">Checked</span>
                                <span className="devConsole__kvValue">
                                    {formatUpdatedAt(obligations.updatedAt)}
                                </span>
                            </div>
                            {obligations.obligations.length === 0 ? (
                                <p>No unsettled financial obligations.</p>
                            ) : (
                                <div className="devConsole__tableWrap">
                                    <table className="devConsole__table">
                                        <thead>
                                            <tr>
                                                <th scope="col">Type</th>
                                                <th scope="col">Room ID</th>
                                                <th scope="col">State</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {obligations.obligations.map((item, index) => (
                                                <tr key={`${item.type}:${item.roomId ?? "unresolved"}:${item.state}:${index}`}>
                                                    <td>{item.type}</td>
                                                    <td>
                                                        {item.roomId ?? `Unassigned${item.candidateRoomIds?.length
                                                            ? ` · candidates: ${item.candidateRoomIds.join(", ")}`
                                                            : ""}`}
                                                        {item.closedRoom ? " · closed" : ""}
                                                    </td>
                                                    <td>{item.state}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </>
                    )}
                </section>
            )}
        </PanelShell>
    );
}
