import { useEffect, useState } from "react";

import { fetchEnvironmentSummary } from "./developerAuthApi";
import { useDeveloperAuth } from "./DeveloperAuthProvider";
import { formatUptime } from "./formatters";

function resolveBannerClass(appEnvironment) {

    if (appEnvironment === "MAINNET") {

        return "devConsole__envBanner devConsole__envBanner--mainnet";

    }

    if (appEnvironment === "TESTNET") {

        return "devConsole__envBanner devConsole__envBanner--testnet";

    }

    return "devConsole__envBanner devConsole__envBanner--development";

}

function resolveIndicator(appEnvironment) {

    if (appEnvironment === "MAINNET") {

        return "🔴 MAINNET";

    }

    if (appEnvironment === "TESTNET") {

        return "🟢 TESTNET";

    }

    return "🟡 DEVELOPMENT";

}

/**
 * R6.2 — Expanded environment summary on every dashboard page.
 */
export default function EnvironmentBanner() {

    const {
        environment,
        accessToken,
        session,
        authEnabled,
        isAuthenticated
    } = useDeveloperAuth();

    const [summary, setSummary] = useState(null);

    const appEnvironment = summary?.appEnvironment || environment || "DEVELOPMENT";

    useEffect(() => {

        let cancelled = false;

        async function load() {

            if (!accessToken) {

                setSummary(null);

                return;

            }

            try {

                const next = await fetchEnvironmentSummary(accessToken);

                if (!cancelled) {

                    setSummary(next);

                }

            } catch {

                if (!cancelled) {

                    setSummary(null);

                }

            }

        }

        load();

        return () => {

            cancelled = true;

        };

    }, [accessToken, environment]);

    const authLabel = !authEnabled
        ? "Open"
        : (isAuthenticated
            ? `${session?.role ?? "Authenticated"}`
            : "Not authenticated");

    return (

        <div
            className={resolveBannerClass(appEnvironment)}
            role="status"
            aria-live="polite"
        >

            <div className="devConsole__envBannerRule" aria-hidden="true">

                ====================================================

            </div>

            <p className="devConsole__envBannerLabel">

                Environment

            </p>

            <p className="devConsole__envBannerValue">

                {resolveIndicator(appEnvironment)}

            </p>

            {appEnvironment === "MAINNET" && (

                <p className="devConsole__envBannerWarning">

                    ⚠ REAL MONEY MODE ⚠

                </p>

            )}

            <dl className="devConsole__envBannerGrid">

                <div>

                    <dt>Blockchain</dt>

                    <dd>{summary?.blockchainLabel ?? "—"}</dd>

                </div>

                <div>

                    <dt>Payments</dt>

                    <dd>{summary?.paymentsMode ?? "—"}</dd>

                </div>

                <div>

                    <dt>Smart Contracts</dt>

                    <dd>{summary?.contractsLabel ?? "—"}</dd>

                </div>

                <div>

                    <dt>Developer Console</dt>

                    <dd>{authLabel}</dd>

                </div>

                <div>

                    <dt>Server Uptime</dt>

                    <dd>

                        {summary?.uptimeMs != null
                            ? formatUptime(summary.uptimeMs)
                            : "—"}

                    </dd>

                </div>

            </dl>

            <div className="devConsole__envBannerRule" aria-hidden="true">

                ====================================================

            </div>

        </div>

    );

}
