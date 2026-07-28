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

        return () => {

            cancelled = true;

        };

    }, [accessToken]);

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

        </PanelShell>

    );

}
