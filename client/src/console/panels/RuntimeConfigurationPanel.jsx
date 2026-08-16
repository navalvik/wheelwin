import { useEffect, useState } from "react";

import { fetchRuntimeConfiguration } from "../developerAuthApi";
import { useDeveloperAuth } from "../DeveloperAuthProvider";
import PanelShell from "./shared/PanelShell";

function InfoRow({ label, value, hint }) {

    return (

        <div className="devConsole__kvRow">

            <span className="devConsole__kvKey">{label}</span>

            <span className="devConsole__kvValue">

                {value ?? "—"}

                {hint ? (

                    <span className="devConsole__kvHint">

                        {" "}
                        ({hint})

                    </span>

                ) : null}

            </span>

        </div>

    );

}

function SectionCard({ title, children }) {

    return (

        <section className="devConsole__opsCard" aria-label={title}>

            <h3 className="devConsole__opsCardTitle">{title}</h3>

            <div className="devConsole__kvList">

                {children}

            </div>

        </section>

    );

}

function formatSeconds(sec) {

    if (sec == null || !Number.isFinite(Number(sec))) {

        return "—";

    }

    return `${Number(sec)} sec`;

}

function formatAddress(address) {

    const text = String(address ?? "").trim();

    return text || "—";

}

/**
 * R17.9G — Runtime Configuration panel (read-only).
 */
export default function RuntimeConfigurationPanel() {

    const { accessToken } = useDeveloperAuth();

    const [config, setConfig] = useState(null);

    const [error, setError] = useState(null);

    useEffect(() => {

        let cancelled = false;

        async function load() {

            if (!accessToken) {

                return;

            }

            try {

                const next = await fetchRuntimeConfiguration(accessToken);

                if (!cancelled) {

                    setConfig(next);

                    setError(null);

                }

            } catch (err) {

                if (!cancelled) {

                    setError(err.message || "Failed to load runtime configuration");

                }

            }

        }

        load();

        return () => {

            cancelled = true;

        };

    }, [accessToken]);

    const timers = config?.timers ?? {};
    const financial = config?.financial ?? {};
    const wallets = config?.wallets ?? {};

    return (

        <PanelShell
            title="Runtime Configuration"
            subtitle="Read-only view of currently effective timers, financial rules, and wallet pins"
        >

            {error && (

                <p className="devConsole__envError" role="alert">{error}</p>

            )}

            {!error && !config && (

                <p className="devConsole__placeholder">Loading…</p>

            )}

            {config && (

                <div className="devConsole__opsStack">

                    <p className="devConsole__placeholder">

                        Mutation is disabled in this stage. Values reflect
                        authoritative server configuration only — no gameplay
                        engines are modified from this panel.
                    </p>

                    <SectionCard title="Game Timers">

                        <InfoRow
                            label="Setup Timer"
                            value={formatSeconds(timers.setupTimeoutSec)}
                        />

                        <InfoRow
                            label="Verify Timer"
                            value={formatSeconds(timers.verifyTimeoutSec)}
                            hint="uses Setup Timer"
                        />

                        <InfoRow
                            label="Payment Timer"
                            value={formatSeconds(timers.paymentTimeoutSec)}
                        />

                        <InfoRow
                            label="Countdown (READY)"
                            value={formatSeconds(timers.countdownDurationSec)}
                        />

                        <InfoRow
                            label="Brake Duration"
                            value={formatSeconds(timers.brakeDurationSec)}
                        />

                        <InfoRow
                            label="SPEED Duration"
                            value={formatSeconds(timers.speedDurationSec)}
                        />

                        <InfoRow
                            label="SELF_TEST Duration"
                            value={formatSeconds(timers.selfTestDurationSec)}
                        />

                        <InfoRow
                            label="Deploy Timeout"
                            value={formatSeconds(timers.deployTimeoutSec)}
                        />

                    </SectionCard>

                    <SectionCard title="Financial Configuration">

                        <InfoRow
                            label="Base Stake #1"
                            value={
                                financial.baseStake1Gram != null
                                    ? `${financial.baseStake1Gram} GRAM`
                                    : "—"
                            }
                        />

                        <InfoRow
                            label="Base Stake #2"
                            value={
                                financial.baseStake10Gram != null
                                    ? `${financial.baseStake10Gram} GRAM`
                                    : "—"
                            }
                        />

                        <InfoRow
                            label="Owner Fee"
                            value={
                                financial.ownerFeePercent != null
                                    ? `${financial.ownerFeePercent} %`
                                    : "—"
                            }
                        />

                    </SectionCard>

                    <SectionCard title="Wallet Configuration">

                        <InfoRow
                            label="Owner Wallet"
                            value={formatAddress(wallets.ownerWallet)}
                        />

                        <InfoRow
                            label="Deploy Wallet"
                            value={formatAddress(wallets.deployWallet)}
                        />

                        <InfoRow
                            label="Reimbursement Wallet"
                            value={formatAddress(wallets.reimbursementWallet)}
                        />

                        <InfoRow
                            label="TON Network"
                            value={wallets.tonNetwork ?? "—"}
                        />

                    </SectionCard>

                </div>

            )}

        </PanelShell>

    );

}
