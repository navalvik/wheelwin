import { useEffect, useState } from "react";

import { fetchWalletBalances } from "../developerAuthApi";
import { useDeveloperAuth } from "../DeveloperAuthProvider";
import EmptyState from "./shared/EmptyState";
import PanelShell from "./shared/PanelShell";

const WALLET_LABELS = Object.freeze({
    OWNER_WALLET: "OWNER WALLET",
    DEPLOYMENT_WALLET: "DEPLOYMENT WALLET",
    DEPLOY_WALLET: "DEPLOYMENT WALLET",
    RESIDUES_WALLET: "RESIDUES WALLET",
    REIMBURSEMENT_WALLET: "RESIDUES WALLET"
});

const WALLET_ORDER = Object.freeze([
    "OWNER_WALLET",
    "DEPLOYMENT_WALLET",
    "RESIDUES_WALLET"
]);

const WALLET_TYPE_ALIASES = Object.freeze({
    OWNER_WALLET: ["OWNER_WALLET"],
    DEPLOYMENT_WALLET: ["DEPLOYMENT_WALLET", "DEPLOY_WALLET"],
    RESIDUES_WALLET: ["RESIDUES_WALLET", "REIMBURSEMENT_WALLET"]
});

/**
 * r18-s104 — Explicit Testnet/Mainnet monitoring tabs. Selection is always
 * explicit; the UI never falls back to the other network's data.
 */
const NETWORK_TABS = Object.freeze([
    Object.freeze({ id: "testnet", label: "TESTNET" }),
    Object.freeze({ id: "mainnet", label: "MAINNET" })
]);

function formatNetwork(network) {

    const text = String(network ?? "").trim();

    return text ? text.toUpperCase() : "—";

}

function statusClass(status) {

    switch (status) {

        case "OK":
            return "devConsole__statusTone--ok";

        case "RPC_ERROR":
            return "devConsole__statusTone--error";

        case "NOT_CONFIGURED":
            return "devConsole__statusTone--warn";

        case "UNAVAILABLE":
            return "devConsole__statusTone--muted";

        default:
            return "devConsole__statusTone--muted";

    }

}

function formatAddress(address) {

    const text = String(address ?? "").trim();

    return text || "—";

}

function formatBalance(balance, unit = "TON") {

    if (balance == null || balance === "") {

        return "—";

    }

    return `${balance} ${unit}`;

}

function formatTimestamp(value) {

    if (!value) {

        return "—";

    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {

        return String(value);

    }

    return date.toLocaleString();

}

function pickWallet(walletsByType, canonicalType) {

    const aliases = WALLET_TYPE_ALIASES[canonicalType] ?? [canonicalType];

    for (const type of aliases) {

        if (walletsByType.has(type)) {

            return walletsByType.get(type);

        }

    }

    return {
        walletType: canonicalType,
        address: null,
        network: null,
        accountId: null,
        balance: null,
        unit: "TON",
        status: "UNAVAILABLE",
        lastUpdated: null
    };

}

function WalletCard({ wallet }) {

    const label = WALLET_LABELS[wallet?.walletType] ?? wallet?.walletType ?? "Wallet";

    return (

        <section className="devConsole__opsCard" aria-label={label}>

            <h3 className="devConsole__opsCardTitle">{label}</h3>

            <div className="devConsole__kvList">

                <div className="devConsole__kvRow">

                    <span className="devConsole__kvKey">Address</span>

                    <span className="devConsole__kvValue">

                        {formatAddress(wallet?.address)}

                    </span>

                </div>

                <div className="devConsole__kvRow">

                    <span className="devConsole__kvKey">Network</span>

                    <span className="devConsole__kvValue">

                        {formatNetwork(wallet?.network)}

                    </span>

                </div>

                <div className="devConsole__kvRow">

                    <span className="devConsole__kvKey">Account</span>

                    <span className="devConsole__kvValue">

                        {formatAddress(wallet?.accountId)}

                    </span>

                </div>

                <div className="devConsole__kvRow">

                    <span className="devConsole__kvKey">Balance</span>

                    <span className="devConsole__kvValue">

                        {formatBalance(wallet?.balance, wallet?.unit)}

                    </span>

                </div>

                <div className="devConsole__kvRow">

                    <span className="devConsole__kvKey">Status</span>

                    <span className="devConsole__kvValue">

                        <span className={statusClass(wallet?.status)}>

                            {wallet?.status ?? "—"}

                        </span>

                    </span>

                </div>

                <div className="devConsole__kvRow">

                    <span className="devConsole__kvKey">Last update</span>

                    <span className="devConsole__kvValue">

                        {formatTimestamp(wallet?.lastUpdated)}

                    </span>

                </div>

                {wallet?.status === "RPC_ERROR" && wallet?.lastSuccessfulUpdate ? (

                    <div className="devConsole__kvRow">

                        <span className="devConsole__kvKey">Last success</span>

                        <span className="devConsole__kvValue">

                            {formatTimestamp(wallet.lastSuccessfulUpdate)}

                        </span>

                    </div>

                ) : null}

            </div>

        </section>

    );

}

/**
 * R17.9H / R17.9I.3 — Wallet Monitoring panel (Administrator-only).
 */
export default function WalletMonitoringPanel() {

    const { accessToken, isAdministrator } = useDeveloperAuth();

    const [snapshot, setSnapshot] = useState(null);

    // r18-s104 — Explicitly selected monitoring network ("testnet"|"mainnet").
    // null until the first snapshot resolves the application network.
    const [activeNetwork, setActiveNetwork] = useState(null);

    const [error, setError] = useState(null);

    const [forbidden, setForbidden] = useState(false);

    useEffect(() => {

        let cancelled = false;

        let timer = null;

        async function load() {

            if (!accessToken || !isAdministrator) {

                return;

            }

            try {

                // r18-s104 — The requested network is explicit in the request.
                const next = await fetchWalletBalances(accessToken, activeNetwork);

                if (cancelled) {

                    return;

                }

                // Defense in depth: the response must carry the requested
                // network. The backend performs fallback-free slicing; any
                // mismatch is a hard error, not a reason to render other data.
                if (
                    activeNetwork
                    && next?.network
                    && next.network !== activeNetwork
                ) {

                    throw new Error("Wallet monitoring network mismatch");

                }

                if (!cancelled) {

                    setSnapshot(next);

                    setError(null);

                    setForbidden(false);

                    if (!activeNetwork && next?.applicationNetwork) {

                        setActiveNetwork(
                            next.applicationNetwork === "mainnet"
                                ? "mainnet"
                                : "testnet"
                        );

                    }

                }

            } catch (err) {

                if (!cancelled) {

                    if (err.status === 403) {

                        setForbidden(true);

                        setSnapshot(null);

                        return;

                    }

                    setError(err.message || "Failed to load wallet balances");

                }

            }

        }

        if (!isAdministrator) {

            return undefined;

        }

        load();

        timer = setInterval(load, 30_000);

        return () => {

            cancelled = true;

            if (timer) {

                clearInterval(timer);

            }

        };

    }, [accessToken, isAdministrator, activeNetwork]);

    if (!isAdministrator || forbidden) {

        return (

            <PanelShell
                title="Wallet Monitoring"
                subtitle="Live TON balances for Owner, Deployment, and Residues wallets"
            >

                <EmptyState
                    title="Administrator access required"
                    detail="Viewer accounts cannot access Wallet Monitoring. Sign in with an Administrator account."
                />

            </PanelShell>

        );

    }

    const walletsByType = new Map(
        (snapshot?.wallets ?? []).map((entry) => [entry.walletType, entry])
    );

    const wallets = WALLET_ORDER.map((type) => pickWallet(walletsByType, type));

    // r18-s104 — Resolved tab. Explicit selection first; the first snapshot
    // defaults the tab to the application's own network. The displayed wallet
    // list is the server-sliced profile for exactly this network.
    const resolvedNetwork = activeNetwork
        ?? (snapshot?.applicationNetwork === "mainnet" ? "mainnet" : null)
        ?? (snapshot ? "testnet" : null);

    return (

        <PanelShell
            title="Wallet Monitoring"
            subtitle="Live TON balances for Owner, Deployment, and Residues wallets"
        >

            {error && (

                <p className="devConsole__envError" role="alert">{error}</p>

            )}

            {!error && !snapshot && (

                <p className="devConsole__placeholder">Loading…</p>

            )}

            {snapshot && (

                <div className="devConsole__opsStack">

                    <div
                        className="devConsole__networkSwitch"
                        role="group"
                        aria-label="Wallet monitoring network"
                    >

                        {NETWORK_TABS.map((tab) => {

                            const profile = snapshot.networkProfiles?.[tab.id] ?? null;
                            const isActive = resolvedNetwork === tab.id;

                            return (

                                <button
                                    key={tab.id}
                                    type="button"
                                    className={`devConsole__button${isActive ? " devConsole__networkSwitchButton--active" : ""}`}
                                    aria-pressed={isActive}
                                    onClick={() => {

                                        if (profile) {

                                            setActiveNetwork(tab.id);

                                        }

                                    }}
                                >

                                    {tab.label}
                                    {snapshot.applicationNetwork === tab.id ? " (APP)" : ""}

                                </button>

                            );

                        })}

                    </div>

                    <p className="devConsole__placeholder">

                        WALLET MONITORING — {formatNetwork(resolvedNetwork)}
                        {" · "}
                        Network: {formatNetwork(snapshot.network)}
                        {" · "}
                        Refresh: {(snapshot.refreshIntervalMs ?? 30000) / 1000}s
                        {" · "}
                        Read-only observability (no signing)
                    </p>

                    {wallets.map((wallet) => (

                        <WalletCard
                            key={wallet.walletType}
                            wallet={wallet}
                        />

                    ))}

                </div>

            )}

        </PanelShell>

    );

}
