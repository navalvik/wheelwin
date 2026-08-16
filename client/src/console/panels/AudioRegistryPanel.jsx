import { useEffect, useState } from "react";

import { fetchAudioRegistry } from "../developerAuthApi";
import { useDeveloperAuth } from "../DeveloperAuthProvider";
import PanelShell from "./shared/PanelShell";

function statusClass(status) {

    switch (status) {

        case "AVAILABLE":
            return "devConsole__statusTone--ok";

        case "MISSING":
            return "devConsole__statusTone--warn";

        default:
            return "devConsole__statusTone--muted";

    }

}

/**
 * R17.9I.2 — Audio Registry panel (read-only event → asset map).
 */
export default function AudioRegistryPanel() {

    const { accessToken } = useDeveloperAuth();

    const [registry, setRegistry] = useState(null);

    const [error, setError] = useState(null);

    useEffect(() => {

        let cancelled = false;

        async function load() {

            if (!accessToken) {

                return;

            }

            try {

                const next = await fetchAudioRegistry(accessToken);

                if (!cancelled) {

                    setRegistry(next);

                    setError(null);

                }

            } catch (err) {

                if (!cancelled) {

                    setError(err.message || "Failed to load audio registry");

                }

            }

        }

        load();

        return () => {

            cancelled = true;

        };

    }, [accessToken]);

    const entries = registry?.entries ?? [];
    const summary = registry?.summary ?? null;

    return (

        <PanelShell
            title="Audio Registry"
            subtitle="Presentation event → asset mapping (read-only; playback stays disabled)"
        >

            {error && (

                <p className="devConsole__envError" role="alert">{error}</p>

            )}

            {!error && !registry && (

                <p className="devConsole__placeholder">Loading…</p>

            )}

            {registry && (

                <div className="devConsole__opsStack">

                    <p className="devConsole__placeholder">

                        Schema v{registry.schemaVersion}
                        {" · "}
                        Total {summary?.total ?? 0}
                        {" · "}
                        Available {summary?.available ?? 0}
                        {" · "}
                        Missing {summary?.missing ?? 0}
                        {" · "}
                        Missing files never interrupt gameplay
                    </p>

                    <div className="devConsole__tableWrap">

                        <table className="devConsole__table">

                            <thead>

                                <tr>

                                    <th>Event ID</th>

                                    <th>File</th>

                                    <th>Category</th>

                                    <th>Loop</th>

                                    <th>Enabled</th>

                                    <th>Status</th>

                                </tr>

                            </thead>

                            <tbody>

                                {entries.map((entry) => (

                                    <tr key={entry.eventId}>

                                        <td>{entry.eventId}</td>

                                        <td>{entry.fileName ?? entry.audioFile}</td>

                                        <td>{entry.category}</td>

                                        <td>{entry.loop ? "YES" : "NO"}</td>

                                        <td>{entry.enabled ? "ON" : "OFF"}</td>

                                        <td>

                                            <span className={statusClass(entry.status)}>

                                                {entry.status}

                                            </span>

                                        </td>

                                    </tr>

                                ))}

                            </tbody>

                        </table>

                    </div>

                </div>

            )}

        </PanelShell>

    );

}
