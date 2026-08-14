import { useEffect, useState } from "react";

import { fetchDeployerWalletStatus } from "../developerAuthApi";
import { useDeveloperAuth } from "../DeveloperAuthProvider";
import PanelShell from "./shared/PanelShell";
import EmptyState from "./shared/EmptyState";

function readinessClass(status) {

    switch (status) {

        case "READY":
            return "devConsole__statusTone--ok";

        case "WARNING":
            return "devConsole__statusTone--warn";

        case "ERROR":
            return "devConsole__statusTone--error";

        default:
            return "devConsole__statusTone--muted";

    }

}

function formatTimestamp(value) {

    if (!value) {

        return "—";

    }

    try {

        return new Date(value).toISOString();

    } catch {

        return String(value);

    }

}

export default function DeployerWalletPanel() {

    const { accessToken, isAdministrator } = useDeveloperAuth();

    const [status, setStatus] = useState(null);

    const [error, setError] = useState(null);

    const [forbidden, setForbidden] = useState(false);

    useEffect(() => {

        let cancelled = false;

        async function load() {

            if (!accessToken) {

                return;

            }

            if (!isAdministrator) {

                setForbidden(true);

                setStatus(null);

                setError(null);

                return;

            }

            setForbidden(false);

            try {

                const next = await fetchDeployerWalletStatus(accessToken);

                if (!cancelled) {

                    setStatus(next);

                    setError(null);

                }

            } catch (err) {

                if (!cancelled) {

                    setStatus(null);

                    setError(err.message || "Failed to load deployer wallet status");

                }

            }

        }

        load();

        return () => {

            cancelled = true;

        };

    }, [accessToken, isAdministrator]);

    if (!isAdministrator || forbidden) {

        return (

            <PanelShell
                title="TON Deployer Wallet"
                subtitle="Live deployer wallet identity and blockchain state"
            >

                <EmptyState
                    title="Administrator access required"
                    detail="Viewer accounts cannot inspect the deployer wallet. Sign in with an Administrator account."
                />

            </PanelShell>

        );

    }

    const readiness = status?.readiness ?? null;

    return (

        <PanelShell
            title="TON Deployer Wallet"
            subtitle="Live deployer wallet identity and blockchain state"
        >

            {error && (

                <p className="devConsole__errorBanner">

                    {error}

                </p>

            )}

            {!status && !error && (

                <p className="devConsole__placeholder">

                    Loading deployer wallet status…

                </p>

            )}

            {status && (

                <>

                    <section className="devConsole__kvSection">

                        <h3 className="devConsole__kvSectionTitle">

                            Identity

                        </h3>

                        <div className="devConsole__kvRow">

                            <span className="devConsole__kvKey">Network</span>

                            <span className="devConsole__kvValue">

                                {status.network ?? "—"}

                            </span>

                        </div>

                        <div className="devConsole__kvRow">

                            <span className="devConsole__kvKey">Wallet Type</span>

                            <span className="devConsole__kvValue">

                                {status.walletType ?? "—"}

                            </span>

                        </div>

                        <div className="devConsole__kvRow">

                            <span className="devConsole__kvKey">Wallet ID</span>

                            <span className="devConsole__kvValue">

                                {status.walletId ?? "—"}

                            </span>

                        </div>

                        <div className="devConsole__kvRow">

                            <span className="devConsole__kvKey">Address</span>

                            <span className="devConsole__kvValue">

                                {status.address ?? "—"}

                            </span>

                        </div>

                    </section>

                    <section className="devConsole__kvSection">

                        <h3 className="devConsole__kvSectionTitle">

                            Blockchain State

                        </h3>

                        <div className="devConsole__kvRow">

                            <span className="devConsole__kvKey">Balance TON</span>

                            <span className="devConsole__kvValue">

                                {status.balance ?? "—"}

                            </span>

                        </div>

                        <div className="devConsole__kvRow">

                            <span className="devConsole__kvKey">Seqno</span>

                            <span className="devConsole__kvValue">

                                {status.seqno ?? "—"}

                            </span>

                        </div>

                        <div className="devConsole__kvRow">

                            <span className="devConsole__kvKey">Last Checked</span>

                            <span className="devConsole__kvValue">

                                {formatTimestamp(status.lastCheckedAt)}

                            </span>

                        </div>

                    </section>

                    <section className="devConsole__kvSection">

                        <h3 className="devConsole__kvSectionTitle">

                            Readiness

                        </h3>

                        <div className="devConsole__kvRow">

                            <span className="devConsole__kvKey">Status</span>

                            <span className={`devConsole__kvValue ${
                                readinessClass(readiness?.status)
                            }`}>

                                {readiness?.status ?? "—"}

                            </span>

                        </div>

                        <div className="devConsole__kvRow">

                            <span className="devConsole__kvKey">Message</span>

                            <span className={`devConsole__kvValue ${
                                readinessClass(readiness?.status)
                            }`}>

                                {readiness?.message ?? "—"}

                            </span>

                        </div>

                    </section>

                </>

            )}

        </PanelShell>

    );

}
