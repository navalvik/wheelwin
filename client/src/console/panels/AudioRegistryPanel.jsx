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
 * R17.9I.4 — Audio Registry runtime controls (enabled / loop).
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

            nextDrafts[entry.id] = {
                enabled: entry.enabled === true,
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

            if (!isAdministrator || !accessToken) {

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

    const updateDraft = useCallback((id, field, value) => {

        setDrafts((prev) => ({
            ...prev,
            [id]: {
                ...prev[id],
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

                const draft = drafts[entry.id];

                if (!draft) {

                    continue;

                }

                const patch = { id: entry.id };
                let dirty = false;

                if (draft.enabled !== entry.enabled) {

                    patch.enabled = draft.enabled === true;
                    dirty = true;

                }

                if (draft.loop !== entry.loop) {

                    patch.loop = draft.loop === true;
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
                subtitle="Runtime controls for game audio assets"
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
            subtitle="Administrator runtime controls — enabled and loop only (playback stays gated)"
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
                        Exists {summary?.available ?? 0}
                        {" · "}
                        Missing {summary?.missing ?? 0}
                        {" · "}
                        id / file / category immutable
                    </p>

                    <div className="devConsole__tableWrap">

                        <table className="devConsole__table">

                            <thead>

                                <tr>

                                    <th>Event/File</th>

                                    <th>Exists</th>

                                    <th>Enabled</th>

                                    <th>Loop</th>

                                    <th>Status</th>

                                </tr>

                            </thead>

                            <tbody>

                                {entries.map((entry) => {

                                    const draft = drafts[entry.id] ?? {
                                        enabled: entry.enabled,
                                        loop: entry.loop
                                    };

                                    return (

                                        <tr key={entry.id}>

                                            <td>

                                                <div>{entry.id}</div>

                                                <div className="devConsole__kvHint">

                                                    {entry.fileName ?? entry.file}

                                                </div>

                                            </td>

                                            <td>

                                                {entry.exists ? "YES" : "NO"}

                                            </td>

                                            <td>

                                                <label className="devConsole__audioToggle">

                                                    <input
                                                        type="checkbox"
                                                        checked={draft.enabled === true}
                                                        onChange={(event) => updateDraft(
                                                            entry.id,
                                                            "enabled",
                                                            event.target.checked
                                                        )}
                                                        aria-label={`${entry.id} enabled`}
                                                    />

                                                    <span>

                                                        {draft.enabled ? "ON" : "OFF"}

                                                    </span>

                                                </label>

                                            </td>

                                            <td>

                                                <label className="devConsole__audioToggle">

                                                    <input
                                                        type="checkbox"
                                                        checked={draft.loop === true}
                                                        onChange={(event) => updateDraft(
                                                            entry.id,
                                                            "loop",
                                                            event.target.checked
                                                        )}
                                                        aria-label={`${entry.id} loop`}
                                                    />

                                                    <span>

                                                        {draft.loop ? "YES" : "NO"}

                                                    </span>

                                                </label>

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
