import { useEffect, useState } from "react";

import { fetchBlockchainStatus } from "../developerAuthApi";
import { useDeveloperAuth } from "../DeveloperAuthProvider";
import PanelShell from "./shared/PanelShell";

const SERVICE_LABELS = Object.freeze({
    tonService: "TonService",
    blockchainMonitor: "BlockchainMonitor",
    walletManager: "WalletManager",
    contractManager: "ContractManager",
    paymentSessionManager: "PaymentSessionManager",
    contractSettlementManager: "ContractSettlementManager",
    tonFinancialRecovery: "TonFinancialRecovery"
});

function statusClass(status) {

    switch (status) {

        case "Healthy":
            return "devConsole__statusTone--ok";

        case "Warning":
            return "devConsole__statusTone--warn";

        case "Initializing":
            return "devConsole__statusTone--info";

        case "Error":
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

export default function BlockchainStatusPanel() {

    const { accessToken } = useDeveloperAuth();

    const [status, setStatus] = useState(null);

    const [error, setError] = useState(null);

    useEffect(() => {

        let cancelled = false;

        async function load() {

            if (!accessToken) {

                return;

            }

            try {

                const next = await fetchBlockchainStatus(accessToken);

                if (!cancelled) {

                    setStatus(next);

                    setError(null);

                }

            } catch (err) {

                if (!cancelled) {

                    setError(err.message || "Failed to load blockchain status");

                }

            }

        }

        load();

        const intervalId = setInterval(load, 5000);

        return () => {

            cancelled = true;

            clearInterval(intervalId);

        };

    }, [accessToken]);

    const deployDebug = status?.tonDeployDebug ?? null;

    return (

        <PanelShell
            title="Blockchain Status"
            subtitle="Read-only TON service diagnostics"
        >

            {error && (

                <p className="devConsole__envError" role="alert">{error}</p>

            )}

            <div className="devConsole__kvRow">

                <span className="devConsole__kvKey">Current Network</span>

                <span className="devConsole__kvValue">{status?.network ?? "—"}</span>

            </div>

            <div className="devConsole__kvRow">

                <span className="devConsole__kvKey">Connection Status</span>

                <span className="devConsole__kvValue">

                    {status?.connectionStatus ?? "—"}

                </span>

            </div>

            <div className="devConsole__serviceStatusList">

                {Object.entries(SERVICE_LABELS).map(([key, label]) => {

                    const service = status?.services?.[key];

                    return (

                        <div key={key} className="devConsole__serviceStatusRow">

                            <span>{label}</span>

                            <span className={statusClass(service?.status)}>

                                {service?.status ?? "Offline"}

                            </span>

                        </div>

                    );

                })}

            </div>

            <h3 className="devConsole__sectionTitle" style={{ marginTop: 24 }}>
                TON Deploy Diagnostics
            </h3>

            <p className="devConsole__muted" style={{ marginBottom: 12 }}>
                Last deploy attempt (R7.51.29). No mnemonics or private keys.
            </p>

            {!deployDebug && (

                <p className="devConsole__muted">No deploy attempt recorded yet.</p>

            )}

            {deployDebug && (

                <>

                    <div className="devConsole__kvRow">

                        <span className="devConsole__kvKey">Last attempt</span>

                        <span className="devConsole__kvValue">

                            {formatTimestamp(deployDebug.timestamp)}

                        </span>

                    </div>

                    <div className="devConsole__kvRow">

                        <span className="devConsole__kvKey">Current stage</span>

                        <span className="devConsole__kvValue">

                            {deployDebug.currentStage ?? "—"}

                        </span>

                    </div>

                    <div className="devConsole__kvRow">

                        <span className="devConsole__kvKey">Room / Game</span>

                        <span className="devConsole__kvValue">

                            {deployDebug.roomId ?? "—"}
                            {" / "}
                            {deployDebug.gameId ?? "—"}

                        </span>

                    </div>

                    <div className="devConsole__kvRow">

                        <span className="devConsole__kvKey">Deployer address</span>

                        <span className="devConsole__kvValue">

                            {deployDebug.deployerAddress ?? "—"}

                        </span>

                    </div>

                    <div className="devConsole__kvRow">

                        <span className="devConsole__kvKey">Wallet id</span>

                        <span className="devConsole__kvValue">

                            {deployDebug.deployerWalletId ?? "—"}

                        </span>

                    </div>

                    <div className="devConsole__kvRow">

                        <span className="devConsole__kvKey">Seqno</span>

                        <span className="devConsole__kvValue">

                            {deployDebug.seqno ?? "—"}

                        </span>

                    </div>

                    <div className="devConsole__kvRow">

                        <span className="devConsole__kvKey">Escrow address</span>

                        <span className="devConsole__kvValue">

                            {deployDebug.escrowAddress ?? "—"}

                        </span>

                    </div>

                    <div className="devConsole__kvRow">

                        <span className="devConsole__kvKey">Value TON</span>

                        <span className="devConsole__kvValue">

                            {deployDebug.valueTon ?? "—"}

                        </span>

                    </div>

                    <div className="devConsole__kvRow">

                        <span className="devConsole__kvKey">Stage path</span>

                        <span className="devConsole__kvValue">

                            {Array.isArray(deployDebug.stage)
                                ? deployDebug.stage.join(" → ")
                                : "—"}

                        </span>

                    </div>

                    <div className="devConsole__kvRow">

                        <span className="devConsole__kvKey">Last error name</span>

                        <span className={`devConsole__kvValue ${
                            deployDebug.errorName
                                ? "devConsole__statusTone--error"
                                : ""
                        }`}>

                            {deployDebug.errorName ?? "—"}

                        </span>

                    </div>

                    <div className="devConsole__kvRow">

                        <span className="devConsole__kvKey">Last error message</span>

                        <span className={`devConsole__kvValue ${
                            deployDebug.errorMessage
                                ? "devConsole__statusTone--error"
                                : ""
                        }`}>

                            {deployDebug.errorMessage ?? "—"}

                        </span>

                    </div>

                </>

            )}

        </PanelShell>

    );

}
