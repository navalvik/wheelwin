import { useCallback, useEffect, useState } from "react";

import {
    fetchAudioRegistry,
    updateAudioRegistry
} from "../developerAuthApi";
import { useDeveloperAuth } from "../DeveloperAuthProvider";
import EmptyState from "./shared/EmptyState";
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
 * R17.9I.3 — Audio Registry panel with Administrator editing.
 */
export default function AudioRegistryPanel() {

    const { accessToken, isAdministrator } = useDeveloperAuth();

    const [registry, setRegistry] = useState(null);

    const [drafts, setDrafts] = useState({});

    const [error, setError] = useState(null);

    const [success, setSuccess] = useState(null);

    const [busy, setBusy] = useState(false);

    const [forbidden, setForbidden] = useState(false);

    const applyRegistry = useCallback((next) => {

        setRegistry(next);

        const nextDrafts = {};

        for (const entry of next?.entries ?? []) {

            nextDrafts[entry.eventId] = {
                enabled: entry.enabled === true,
                volume: entry.volume,
                loop: entry.loop === true
            };

        }

        setDrafts(nextDrafts);

    }, []);

    const load = useCallback(async () => {

        if (!accessToken || !isAdministrator) {

            return;

        }

        const next = await fetchAudioRegistry(accessToken);

        applyRegistry(next);

        setError(null);

        setForbidden(false);

    }, [accessToken, applyRegistry, isAdministrator]);

    useEffect(() => {

        let cancelled = false;

        async function run() {

            if (!isAdministrator) {

                return;

            }

            if (!accessToken) {

                return;

            }

            try {

                await load();

            } catch (err) {

                if (cancelled) {

                    return;

                }

                if (err.status === 403) {

                    setForbidden(true);

                    setRegistry(null);

                    return;

                }

                setError(err.message || "Failed to load audio registry");

            }

        }

        run();

        return () => {

            cancelled = true;

        };

    }, [accessToken, isAdministrator, load]);

    const updateDraft = useCallback((eventId, field, value) => {

        setDrafts((prev) => ({
            ...prev,
            [eventId]: {
                ...prev[eventId],
                [field]: value
            }
        }));

        setSuccess(null);

    }, []);

    const save = useCallback(async (event) => {

        event.preventDefault();

        if (!isAdministrator || !accessToken || !registry) {

            return;

        }

        setBusy(true);

        setError(null);

        setSuccess(null);

        try {

            const entries = [];

            for (const entry of registry.entries ?? []) {

                const draft = drafts[entry.eventId];

                if (!draft) {

                    continue;

                }

                const patch = { eventId: entry.eventId };
                let dirty = false;

                if (draft.enabled !== entry.enabled) {

                    patch.enabled = draft.enabled === true;
                    dirty = true;

                }

                if (draft.loop !== entry.loop) {

                    patch.loop = draft.loop === true;
                    dirty = true;

                }

                if (Number(draft.volume) !== Number(entry.volume)) {

                    patch.volume = Number(draft.volume);
                    dirty = true;

                }

                if (dirty) {

                    entries.push(patch);

                }

            }

            if (entries.length === 0) {

                setSuccess("No changes to save.");

                return;

            }

            const result = await updateAudioRegistry(accessToken, { entries });

            setSuccess(
                result.message
                || "Saved. Changes apply to future audio sessions only."
            );

            if (result.registry) {

                applyRegistry(result.registry);

            } else {

                await load();

            }

        } catch (err) {

            setError(err.message || "Failed to save audio registry");

        } finally {

            setBusy(false);

        }

    }, [
        accessToken,
        applyRegistry,
        drafts,
        isAdministrator,
        load,
        registry
    ]);

    if (!isAdministrator || forbidden) {

        return (

            <PanelShell
                title="Audio Registry"
                subtitle="Presentation event → asset mapping"
            >

                <EmptyState
                    title="Administrator access required"
                    detail="Viewer accounts cannot access Audio Registry. Sign in with an Administrator account."
                />

            </PanelShell>

        );

    }

    const entries = registry?.entries ?? [];
    const summary = registry?.summary ?? null;

    return (

        <PanelShell
            title="Audio Registry"
            subtitle="Administrator controls for enabled, volume, and loop (playback stays disabled)"
        >

            {error && (

                <p className="devConsole__envError" role="alert">{error}</p>

            )}

            {success && (

                <p className="devConsole__envSuccess" role="status">{success}</p>

            )}

            {!error && !registry && (

                <p className="devConsole__placeholder">Loading…</p>

            )}

            {registry && (

                <form className="devConsole__opsStack" onSubmit={save}>

                    <p className="devConsole__placeholder">

                        Schema v{registry.schemaVersion}
                        {" · "}
                        Config v{registry.configVersion ?? 0}
                        {" · "}
                        Available {summary?.available ?? 0}
                        {" · "}
                        Missing {summary?.missing ?? 0}
                        {" · "}
                        eventId / file / category are immutable
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

                                    <th>Volume</th>

                                    <th>Status</th>

                                </tr>

                            </thead>

                            <tbody>

                                {entries.map((entry) => {

                                    const draft = drafts[entry.eventId] ?? {
                                        enabled: entry.enabled,
                                        volume: entry.volume,
                                        loop: entry.loop
                                    };

                                    return (

                                        <tr key={entry.eventId}>

                                            <td>{entry.eventId}</td>

                                            <td>
                                                {entry.fileName ?? entry.audioFile}
                                            </td>

                                            <td>{entry.category}</td>

                                            <td>

                                                <input
                                                    type="checkbox"
                                                    checked={draft.loop === true}
                                                    onChange={(event) => updateDraft(
                                                        entry.eventId,
                                                        "loop",
                                                        event.target.checked
                                                    )}
                                                    aria-label={`${entry.eventId} loop`}
                                                />

                                            </td>

                                            <td>

                                                <input
                                                    type="checkbox"
                                                    checked={draft.enabled === true}
                                                    onChange={(event) => updateDraft(
                                                        entry.eventId,
                                                        "enabled",
                                                        event.target.checked
                                                    )}
                                                    aria-label={`${entry.eventId} enabled`}
                                                />

                                            </td>

                                            <td>

                                                <input
                                                    type="number"
                                                    min="0"
                                                    max="1"
                                                    step="0.01"
                                                    value={draft.volume ?? 0}
                                                    onChange={(event) => updateDraft(
                                                        entry.eventId,
                                                        "volume",
                                                        event.target.value
                                                    )}
                                                    aria-label={`${entry.eventId} volume`}
                                                    className="devConsole__audioVolumeInput"
                                                />

                                            </td>

                                            <td>

                                                <span className={statusClass(entry.status)}>

                                                    {entry.status}

                                                </span>

                                            </td>

                                        </tr>

                                    );

                                })}

                            </tbody>

                        </table>

                    </div>

                    <div>

                        <button
                            type="submit"
                            className="devConsole__envSubmit"
                            disabled={busy}
                        >

                            {busy ? "Saving…" : "Save Audio Registry"}

                        </button>

                    </div>

                </form>

            )}

        </PanelShell>

    );

}
