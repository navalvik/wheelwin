import { useEffect, useState } from "react";

import { fetchWalletBalances } from "../developerAuthApi";
import { useDeveloperAuth } from "../DeveloperAuthProvider";
import EmptyState from "./shared/EmptyState";
import PanelShell from "./shared/PanelShell";

const WALLET_LABELS = Object.freeze({
    OWNER_WALLET: "OWNER WALLET",
    DEPLOY_WALLET: "Deploy Wallet",
    REIMBURSEMENT_WALLET: "Reimbursement Wallet"
});

const WALLET_ORDER = Object.freeze([
    "OWNER_WALLET",
    "DEPLOY_WALLET",
    "REIMBURSEMENT_WALLET"
]);

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

                const next = await fetchWalletBalances(accessToken);

                if (!cancelled) {

                    setSnapshot(next);

                    setError(null);

                    setForbidden(false);

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

    }, [accessToken, isAdministrator]);

    if (!isAdministrator || forbidden) {

        return (

            <PanelShell
                title="Wallet Monitoring"
                subtitle="Live TON balances for Owner, Deploy, and Reimbursement wallets"
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

    const wallets = WALLET_ORDER.map((type) => walletsByType.get(type) ?? {
        walletType: type,
        address: null,
        balance: null,
        unit: "TON",
        status: "UNAVAILABLE",
        lastUpdated: null
    });

    return (

        <PanelShell
            title="Wallet Monitoring"
            subtitle="Live TON balances for Owner, Deploy, and Reimbursement wallets"
        >

            {error && (

                <p className="devConsole__envError" role="alert">{error}</p>

            )}

            {!error && !snapshot && (

                <p className="devConsole__placeholder">Loading…</p>

            )}

            {snapshot && (

                <div className="devConsole__opsStack">

                    <p className="devConsole__placeholder">

                        Network: {snapshot.network ?? "—"}
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
