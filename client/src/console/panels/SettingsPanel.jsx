import { useCallback, useEffect, useState } from "react";

import PanelShell from "./shared/PanelShell";
import {
    fetchEnvironmentStatus,
    switchAppEnvironment
} from "../developerAuthApi";
import { useDeveloperAuth } from "../DeveloperAuthProvider";

const MAINNET_CONFIRMATION_PHRASE = "ENABLE MAINNET";

const FINAL_UNDERSTAND_PHRASE = "I UNDERSTAND";

function EnvironmentSwitchForm({
    currentEnvironment,
    onSwitched
}) {

    const { accessToken } = useDeveloperAuth();

    const [targetEnvironment, setTargetEnvironment] = useState("TESTNET");

    const [password, setPassword] = useState("");

    const [confirmationPhrase, setConfirmationPhrase] = useState("");

    const [finalConfirmationPhrase, setFinalConfirmationPhrase] = useState("");

    const [busy, setBusy] = useState(false);

    const [error, setError] = useState(null);

    const [success, setSuccess] = useState(null);

    const requiresMainnetProtection = targetEnvironment === "MAINNET"
        && currentEnvironment !== "MAINNET";

    const requiresPassword = (targetEnvironment === "MAINNET"
            && currentEnvironment !== "MAINNET")
        || (currentEnvironment === "MAINNET"
            && targetEnvironment !== "MAINNET");

    const submit = useCallback(async (event) => {

        event.preventDefault();

        setBusy(true);

        setError(null);

        setSuccess(null);

        try {

            const result = await switchAppEnvironment({
                accessToken,
                targetEnvironment,
                password: requiresPassword ? password : undefined,
                confirmationPhrase: requiresMainnetProtection
                    ? confirmationPhrase
                    : undefined,
                finalConfirmationPhrase: requiresMainnetProtection
                    ? finalConfirmationPhrase
                    : undefined
            });

            setSuccess(result.message || "Environment updated.");

            setPassword("");

            setConfirmationPhrase("");

            setFinalConfirmationPhrase("");

            onSwitched?.(result);

        } catch (err) {

            setError(err.message || "Environment switch failed");

        } finally {

            setBusy(false);

        }

    }, [
        accessToken,
        confirmationPhrase,
        currentEnvironment,
        finalConfirmationPhrase,
        onSwitched,
        password,
        requiresMainnetProtection,
        requiresPassword,
        targetEnvironment
    ]);

    return (

        <form className="devConsole__envForm" onSubmit={submit}>

            <label className="devConsole__envField">

                <span>Target environment</span>

                <select
                    value={targetEnvironment}
                    onChange={(event) => {

                        setTargetEnvironment(event.target.value);

                        setError(null);

                        setSuccess(null);

                    }}
                >

                    <option value="DEVELOPMENT">DEVELOPMENT</option>

                    <option value="TESTNET">TESTNET</option>

                    <option value="MAINNET">MAINNET</option>

                </select>

            </label>

            {requiresPassword && (

                <label className="devConsole__envField">

                    <span>Administrator password</span>

                    <input
                        type="password"
                        autoComplete="current-password"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        required
                    />

                </label>

            )}

            {requiresMainnetProtection && (

                <>

                    <div className="devConsole__envConfirmBox">

                        <p>-----------------------------------------</p>

                        <p>

                            Current Environment:

                            <strong> {currentEnvironment}</strong>

                        </p>

                        <p>

                            Target Environment:

                            <strong> MAINNET</strong>

                        </p>

                        <p className="devConsole__envWarning">

                            ⚠ WARNING ⚠

                        </p>

                        <p>

                            You are about to enable REAL blockchain payments.

                        </p>

                        <p>

                            This action affects ALL future games created after restart.

                        </p>

                        <p>-----------------------------------------</p>

                    </div>

                    <label className="devConsole__envField">

                        <span>

                            Type

                            {" "}

                            <code>{MAINNET_CONFIRMATION_PHRASE}</code>

                        </span>

                        <input
                            type="text"
                            value={confirmationPhrase}
                            onChange={(event) => setConfirmationPhrase(event.target.value)}
                            required
                        />

                    </label>

                    <label className="devConsole__envField">

                        <span>

                            Type

                            {" "}

                            <code>{FINAL_UNDERSTAND_PHRASE}</code>

                            {" "}

                            to confirm

                        </span>

                        <input
                            type="text"
                            value={finalConfirmationPhrase}
                            onChange={(event) => setFinalConfirmationPhrase(event.target.value)}
                            required
                        />

                    </label>

                </>

            )}

            {error && (

                <p className="devConsole__envError" role="alert">

                    {error}

                </p>

            )}

            {success && (

                <p className="devConsole__envSuccess" role="status">

                    {success}

                </p>

            )}

            <button
                type="submit"
                className="devConsole__envSubmit"
                disabled={busy || targetEnvironment === currentEnvironment}
            >

                {targetEnvironment === "MAINNET"
                    && currentEnvironment !== "MAINNET"
                    ? "Switch to MAINNET"
                    : `Switch to ${targetEnvironment}`}

            </button>

        </form>

    );

}

export default function SettingsPanel() {

    const { accessToken, environment, isAdministrator } = useDeveloperAuth();

    const [status, setStatus] = useState(null);

    const [loadError, setLoadError] = useState(null);

    const refreshStatus = useCallback(async () => {

        if (!accessToken) {

            return;

        }

        try {

            const next = await fetchEnvironmentStatus(accessToken);

            setStatus(next);

            setLoadError(null);

        } catch (err) {

            setLoadError(err.message || "Failed to load environment status");

        }

    }, [accessToken]);

    useEffect(() => {

        refreshStatus();

    }, [refreshStatus]);

    const currentEnvironment = status?.appEnvironment
        || environment
        || "DEVELOPMENT";

    return (

        <PanelShell
            title="Settings"
            subtitle="Administrator authentication and environment control"
        >

            <section className="devConsole__envSection">

                <h3 className="devConsole__envSectionTitle">

                    Current environment

                </h3>

                <p className="devConsole__envCurrent">

                    {currentEnvironment}

                    {status?.tonNetwork ? ` (${status.tonNetwork})` : ""}

                </p>

                {status?.persisted && (

                    <p className="devConsole__envHint">

                        Persisted configuration is active after restart.

                    </p>

                )}

                {loadError && (

                    <p className="devConsole__envError" role="alert">

                        {loadError}

                    </p>

                )}

            </section>

            <section className="devConsole__envSection">

                <h3 className="devConsole__envSectionTitle">

                    Environment control

                </h3>

                {!isAdministrator ? (

                    <p className="devConsole__envHint">

                        Viewer accounts may inspect diagnostics but cannot switch
                        environments or change settings.

                    </p>

                ) : (

                    <>

                        <p className="devConsole__envHint">

                            Switching TESTNET → MAINNET requires password
                            verification, typing ENABLE MAINNET, and typing
                            I UNDERSTAND. Server restart is required to apply
                            blockchain network changes.

                        </p>

                        <EnvironmentSwitchForm
                            currentEnvironment={currentEnvironment}
                            onSwitched={refreshStatus}
                        />

                    </>

                )}

            </section>

        </PanelShell>

    );

}
