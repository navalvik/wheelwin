import { useEffect, useState } from "react";

import { fetchSystemInformation } from "../developerAuthApi";
import { useDeveloperAuth } from "../DeveloperAuthProvider";
import PanelShell from "./shared/PanelShell";
import { formatTimestamp, formatUptime } from "../formatters";

function InfoRow({ label, value }) {

    return (

        <div className="devConsole__kvRow">

            <span className="devConsole__kvKey">{label}</span>

            <span className="devConsole__kvValue">{value ?? "—"}</span>

        </div>

    );

}

export default function SystemInformationPanel() {

    const { accessToken } = useDeveloperAuth();

    const [info, setInfo] = useState(null);

    const [error, setError] = useState(null);

    useEffect(() => {

        let cancelled = false;

        async function load() {

            if (!accessToken) {

                return;

            }

            try {

                const next = await fetchSystemInformation(accessToken);

                if (!cancelled) {

                    setInfo(next);

                    setError(null);

                }

            } catch (err) {

                if (!cancelled) {

                    setError(err.message || "Failed to load system information");

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
            title="System Information"
            subtitle="Read-only server build and runtime metadata"
        >

            {error && (

                <p className="devConsole__envError" role="alert">{error}</p>

            )}

            <InfoRow label="Application Version" value={info?.applicationVersion} />

            <InfoRow
                label="Build Timestamp"
                value={info?.buildTimestamp
                    ? formatTimestamp(info.buildTimestamp)
                    : null}
            />

            <InfoRow label="Node.js Version" value={info?.nodeVersion} />

            <InfoRow label="Platform" value={info?.platform} />

            <InfoRow label="Git Commit" value={info?.gitCommit} />

            <InfoRow
                label="Server Start Time"
                value={info?.serverStartTime
                    ? formatTimestamp(info.serverStartTime)
                    : null}
            />

            <InfoRow
                label="Current Uptime"
                value={info?.uptimeMs != null ? formatUptime(info.uptimeMs) : null}
            />

            <InfoRow label="Environment" value={info?.environment} />

            <InfoRow label="Node Environment" value={info?.nodeEnvironment} />

            <InfoRow label="TON Network" value={info?.tonNetwork} />

            <InfoRow label="TON Deploy Mode" value={info?.tonDeployMode} />

        </PanelShell>

    );

}
