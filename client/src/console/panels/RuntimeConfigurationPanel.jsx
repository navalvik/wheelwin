import { useCallback, useEffect, useState } from "react";

import {
    fetchRuntimeConfiguration,
    updateRuntimeConfiguration
} from "../developerAuthApi";
import { useDeveloperAuth } from "../DeveloperAuthProvider";
import EmptyState from "./shared/EmptyState";
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

function EditRow({ label, value, onChange, unit, hint, readOnly = false }) {

    return (

        <label className="devConsole__envField">

            <span>

                {label}

                {hint ? (

                    <span className="devConsole__kvHint">

                        {" "}
                        ({hint})

                    </span>

                ) : null}

            </span>

            {readOnly ? (

                <input
                    type="text"
                    value={value ?? ""}
                    readOnly
                    disabled
                />

            ) : (

                <div className="devConsole__runtimeEditRow">

                    <input
                        type="number"
                        step="any"
                        value={value ?? ""}
                        onChange={(event) => onChange(event.target.value)}
                    />

                    {unit ? (

                        <span className="devConsole__kvHint">{unit}</span>

                    ) : null}

                </div>

            )}

        </label>

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

function msToSecInput(ms) {

    if (ms == null || !Number.isFinite(Number(ms))) {

        return "";

    }

    return String(Math.round(Number(ms) / 1000));

}

function secInputToMs(value) {

    const n = Number(value);

    if (!Number.isFinite(n) || n <= 0) {

        return null;

    }

    return Math.round(n * 1000);

}

/**
 * R17.9G.1 — Runtime Configuration panel with Administrator editing.
 */
export default function RuntimeConfigurationPanel() {

    const { accessToken, isAdministrator } = useDeveloperAuth();

    const [config, setConfig] = useState(null);

    const [error, setError] = useState(null);

    const [success, setSuccess] = useState(null);

    const [busy, setBusy] = useState(false);

    const [draft, setDraft] = useState(null);

    const load = useCallback(async () => {

        if (!accessToken) {

            return;

        }

        const next = await fetchRuntimeConfiguration(accessToken);

        setConfig(next);

        if (next?.canEdit && next.timers && next.financial) {

            setDraft({
                setupTimeoutSec: msToSecInput(next.timers.setupTimeoutMs),
                paymentTimeoutSec: msToSecInput(next.timers.paymentTimeoutMs),
                countdownDurationSec: msToSecInput(
                    next.timers.countdownDurationMs
                ),
                brakeDurationSec: msToSecInput(next.timers.brakeDurationMs),
                settlementTimeoutSec: msToSecInput(
                    next.timers.settlementTimeoutMs
                ),
                baseStake1Gram: next.financial.baseStake1Gram ?? "",
                baseStake2Gram: next.financial.baseStake2Gram
                    ?? next.financial.baseStake10Gram
                    ?? "",
                ownerFeePercent: next.financial.ownerFeePercent ?? ""
            });

        } else {

            setDraft(null);

        }

        setError(null);

    }, [accessToken]);

    useEffect(() => {

        let cancelled = false;

        async function run() {

            if (!accessToken) {

                return;

            }

            try {

                await load();

            } catch (err) {

                if (!cancelled) {

                    setError(err.message || "Failed to load runtime configuration");

                }

            }

        }

        run();

        return () => {

            cancelled = true;

        };

    }, [accessToken, load]);

    const save = useCallback(async (event) => {

        event.preventDefault();

        if (!isAdministrator || !draft || !accessToken) {

            return;

        }

        setBusy(true);

        setError(null);

        setSuccess(null);

        try {

            const values = {
                setupTimeoutMs: secInputToMs(draft.setupTimeoutSec),
                paymentTimeoutMs: secInputToMs(draft.paymentTimeoutSec),
                countdownDurationMs: secInputToMs(draft.countdownDurationSec),
                brakeDurationMs: secInputToMs(draft.brakeDurationSec),
                settlementTimeoutMs: secInputToMs(draft.settlementTimeoutSec),
                baseStake1Gram: Number(draft.baseStake1Gram),
                baseStake2Gram: Number(draft.baseStake2Gram),
                ownerFeePercent: Number(draft.ownerFeePercent)
            };

            for (const [key, value] of Object.entries(values)) {

                if (value == null || !Number.isFinite(value)) {

                    throw new Error(`Invalid value for ${key}`);

                }

            }

            const result = await updateRuntimeConfiguration(accessToken, values);

            setSuccess(
                result.message
                || "Saved. Changes apply to the next game initialization only."
            );

            if (result.configuration) {

                setConfig(result.configuration);

                const next = result.configuration;

                setDraft({
                    setupTimeoutSec: msToSecInput(next.timers.setupTimeoutMs),
                    paymentTimeoutSec: msToSecInput(next.timers.paymentTimeoutMs),
                    countdownDurationSec: msToSecInput(
                        next.timers.countdownDurationMs
                    ),
                    brakeDurationSec: msToSecInput(next.timers.brakeDurationMs),
                    settlementTimeoutSec: msToSecInput(
                        next.timers.settlementTimeoutMs
                    ),
                    baseStake1Gram: next.financial.baseStake1Gram ?? "",
                    baseStake2Gram: next.financial.baseStake2Gram ?? "",
                    ownerFeePercent: next.financial.ownerFeePercent ?? ""
                });

            } else {

                await load();

            }

        } catch (err) {

            setError(err.message || "Failed to save runtime configuration");

        } finally {

            setBusy(false);

        }

    }, [accessToken, draft, isAdministrator, load]);

    if (!isAdministrator) {

        return (

            <PanelShell
                title="Runtime Configuration"
                subtitle="Timers, financial rules, and wallet pins"
            >

                <EmptyState
                    title="Administrator access required"
                    detail="Viewer accounts cannot view or edit Runtime Configuration values. Sign in with an Administrator account."
                />

                {config?.wallets ? (

                    <SectionCard title="Wallet Configuration (read-only)">

                        <InfoRow
                            label="Owner Wallet"
                            value={formatAddress(config.wallets.ownerWallet)}
                        />

                        <InfoRow
                            label="Deploy Wallet"
                            value={formatAddress(config.wallets.deployWallet)}
                        />

                        <InfoRow
                            label="Reimbursement Wallet"
                            value={formatAddress(
                                config.wallets.reimbursementWallet
                            )}
                        />

                    </SectionCard>

                ) : null}

            </PanelShell>

        );

    }

    const timers = config?.timers ?? {};
    const financial = config?.financial ?? {};
    const wallets = config?.wallets ?? {};

    return (

        <PanelShell
            title="Runtime Configuration"
            subtitle="Edit timers and financial defaults for future game sessions"
        >

            {error && (

                <p className="devConsole__envError" role="alert">{error}</p>

            )}

            {success && (

                <p className="devConsole__envSuccess" role="status">{success}</p>

            )}

            {!error && !config && (

                <p className="devConsole__placeholder">Loading…</p>

            )}

            {config && draft && (

                <form className="devConsole__opsStack" onSubmit={save}>

                    <p className="devConsole__placeholder">

                        Changes apply to the next GAME_INITIALIZED snapshot
                        only. Running games keep their frozen configuration.
                        Config version: {config.configVersion ?? 0}
                    </p>

                    <SectionCard title="Game Lifecycle Timers">

                        <EditRow
                            label="Setup Timer"
                            unit="sec"
                            value={draft.setupTimeoutSec}
                            onChange={(value) => setDraft((prev) => ({
                                ...prev,
                                setupTimeoutSec: value
                            }))}
                        />

                        <EditRow
                            label="Verify Timer"
                            unit="sec"
                            value={draft.setupTimeoutSec}
                            hint="inherited from Setup Timer"
                            readOnly
                        />

                        <EditRow
                            label="Payment Timer"
                            unit="sec"
                            value={draft.paymentTimeoutSec}
                            onChange={(value) => setDraft((prev) => ({
                                ...prev,
                                paymentTimeoutSec: value
                            }))}
                        />

                        <EditRow
                            label="Countdown Duration"
                            unit="sec"
                            value={draft.countdownDurationSec}
                            hint="READY phase"
                            onChange={(value) => setDraft((prev) => ({
                                ...prev,
                                countdownDurationSec: value
                            }))}
                        />

                        <EditRow
                            label="Brake Duration"
                            unit="sec"
                            value={draft.brakeDurationSec}
                            onChange={(value) => setDraft((prev) => ({
                                ...prev,
                                brakeDurationSec: value
                            }))}
                        />

                        <EditRow
                            label="Settlement Timeout"
                            unit="sec"
                            value={draft.settlementTimeoutSec}
                            onChange={(value) => setDraft((prev) => ({
                                ...prev,
                                settlementTimeoutSec: value
                            }))}
                        />

                    </SectionCard>

                    <SectionCard title="Financial Configuration">

                        <EditRow
                            label="Base Stake #1"
                            unit="GRAM"
                            value={draft.baseStake1Gram}
                            onChange={(value) => setDraft((prev) => ({
                                ...prev,
                                baseStake1Gram: value
                            }))}
                        />

                        <EditRow
                            label="Base Stake #2"
                            unit="GRAM"
                            value={draft.baseStake2Gram}
                            onChange={(value) => setDraft((prev) => ({
                                ...prev,
                                baseStake2Gram: value
                            }))}
                        />

                        <EditRow
                            label="Owner Fee Percent"
                            unit="%"
                            value={draft.ownerFeePercent}
                            onChange={(value) => setDraft((prev) => ({
                                ...prev,
                                ownerFeePercent: value
                            }))}
                        />

                    </SectionCard>

                    <SectionCard title="Wallet Configuration">

                        <InfoRow
                            label="Owner Wallet"
                            value={formatAddress(wallets.ownerWallet)}
                            hint="read-only"
                        />

                        <InfoRow
                            label="Deploy Wallet"
                            value={formatAddress(wallets.deployWallet)}
                            hint="read-only"
                        />

                        <InfoRow
                            label="Reimbursement Wallet"
                            value={formatAddress(wallets.reimbursementWallet)}
                            hint="read-only"
                        />

                        <InfoRow
                            label="TON Network"
                            value={wallets.tonNetwork ?? "—"}
                        />

                    </SectionCard>

                    <div>

                        <button
                            type="submit"
                            className="devConsole__envSubmit"
                            disabled={busy}
                        >

                            {busy ? "Saving…" : "Save Runtime Configuration"}

                        </button>

                    </div>

                </form>

            )}

            {config && !draft && (

                <p className="devConsole__placeholder">

                    Configuration loaded but editing is unavailable.
                    Setup={formatSeconds(timers.setupTimeoutSec)}
                    {" · "}
                    Fee={financial.ownerFeePercent != null
                        ? `${financial.ownerFeePercent} %`
                        : "—"}

                </p>

            )}

        </PanelShell>

    );

}
