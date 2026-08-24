import { useCallback, useEffect, useMemo, useState } from "react";

import { useDeveloperAuth } from "../DeveloperAuthProvider";
import {
    createAdvertisement,
    deleteAdvertisement,
    disableAdvertisement,
    getAdvertisement,
    listAdvertisements,
    renewAdvertisement,
    updateAdvertisement,
    uploadAdvertisement
} from "../developerAuthApi";
import { formatBytes, shortId } from "../formatters";
import PanelShell from "./shared/PanelShell";
import Toolbar, { FilterSelect } from "./shared/Toolbar";
import { DataTable, KeyValueList } from "./shared/DataTable";
import EmptyState from "./shared/EmptyState";
import { StatCard, StatGrid } from "./shared/StatGrid";
import { StatusBadge } from "./shared/StatusDot";

const STATUS_EDIT_OPTIONS = [
    { value: "ACTIVE", label: "ACTIVE" },
    { value: "DISABLED", label: "DISABLED" },
    { value: "WAITING_OWNER_RENEWAL", label: "WAITING_OWNER_RENEWAL" },
    { value: "ARCHIVED", label: "ARCHIVED" }
];

function campaignStatusTone(status) {

    switch (status) {

        case "ACTIVE":
            return "green";

        case "DISABLED":
            return "red";

        case "WAITING_OWNER_RENEWAL":
        case "ARCHIVED":
            return "yellow";

        default:
            return "unknown";

    }

}

function formatIsoTimestamp(value) {

    if (!value) {

        return "—";

    }

    try {

        return new Date(value).toLocaleString();

    } catch {

        return String(value);

    }

}

function toIsoFromDatetimeLocal(value) {

    if (!value) {

        return null;

    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {

        return null;

    }

    return date.toISOString();

}

function toDatetimeLocalValue(value) {

    if (!value) {

        return "";

    }

    try {

        const date = new Date(value);

        if (Number.isNaN(date.getTime())) {

            return "";

        }

        const pad = (n) => String(n).padStart(2, "0");

        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
            + `T${pad(date.getHours())}:${pad(date.getMinutes())}`;

    } catch {

        return "";

    }

}

function readFileAsBase64(file) {

    return new Promise((resolve, reject) => {

        const reader = new FileReader();

        reader.onload = () => {

            const result = String(reader.result ?? "");
            const comma = result.indexOf(",");

            resolve(comma >= 0 ? result.slice(comma + 1) : result);

        };

        reader.onerror = () => {

            reject(new Error("Failed to read selected file"));

        };

        reader.readAsDataURL(file);

    });

}

function buildDetailEntries(campaign) {

    if (!campaign) {

        return [];

    }

    return [
        {
            label: "Campaign ID",
            value: campaign.id
        },
        {
            label: "Filename",
            value: campaign.filename
        },
        {
            label: "Advertiser",
            value: campaign.advertiserName || "—"
        },
        {
            label: "Destination URL",
            value: campaign.destinationUrl
                ? (
                    <a
                        href={campaign.destinationUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        {campaign.destinationUrl}
                    </a>
                )
                : "—"
        },
        {
            label: "Priority",
            value: campaign.priority
        },
        {
            label: "Status",
            value: (
                <StatusBadge tone={campaignStatusTone(campaign.status)}>
                    {campaign.status ?? "—"}
                </StatusBadge>
            )
        },
        {
            label: "Renewal Status",
            value: campaign.renewalStatus ?? "—"
        },
        {
            label: "Impressions",
            value: campaign.impressionCount ?? 0
        },
        {
            label: "Clicks",
            value: campaign.clickCount ?? 0
        },
        {
            label: "Created At",
            value: formatIsoTimestamp(campaign.createdAt)
        },
        {
            label: "Updated At",
            value: formatIsoTimestamp(campaign.updatedAt)
        },
        {
            label: "Expires At",
            value: formatIsoTimestamp(campaign.expiresAt)
        },
        {
            label: "Asset Size",
            value: formatBytes(campaign.sizeBytes)
        },
        {
            label: "Created By",
            value: campaign.createdBy ?? "—"
        }
    ];

}

function UploadBannerForm({ token, onUploaded }) {

    const [file, setFile] = useState(null);
    const [filenameOverride, setFilenameOverride] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [success, setSuccess] = useState("");

    const submit = useCallback(async (event) => {

        event.preventDefault();
        setError("");
        setSuccess("");

        if (!file) {

            setError("Select a banner file first.");

            return;

        }

        setBusy(true);

        try {

            const contentBase64 = await readFileAsBase64(file);
            const filename = filenameOverride.trim() || file.name;
            const uploaded = await uploadAdvertisement(token, {
                filename,
                contentBase64
            });

            setSuccess(
                `Uploaded ${uploaded.filename}`
                + (uploaded.sizeBytes != null
                    ? ` (${formatBytes(uploaded.sizeBytes)})`
                    : "")
            );
            setFile(null);
            setFilenameOverride("");
            onUploaded?.(uploaded);

        } catch (err) {

            setError(err.message || "Upload failed");

        } finally {

            setBusy(false);

        }

    }, [file, filenameOverride, onUploaded, token]);

    return (

        <form className="devConsole__envForm" onSubmit={submit}>

            <h3 className="devConsole__sectionTitle">Upload Banner</h3>

            <p className="devConsole__envHint">

                Filename must match

                {" "}

                <code>{"{priority}_{slug}.{jpg|jpeg|png|webp|gif}"}</code>

                . Backend enforces size and quota limits.

            </p>

            <label className="devConsole__envField">

                <span>Banner file</span>

                <input
                    type="file"
                    accept=".jpg,.jpeg,.png,.webp,.gif,image/jpeg,image/png,image/webp,image/gif"
                    onChange={(event) => {

                        const next = event.target.files?.[0] ?? null;

                        setFile(next);
                        setFilenameOverride(next?.name ?? "");
                        setError("");
                        setSuccess("");

                    }}
                />

            </label>

            {file && (

                <p className="devConsole__envHint">

                    Selected:

                    {" "}

                    <strong>{file.name}</strong>

                    {" "}

                    ({formatBytes(file.size)})

                </p>

            )}

            <label className="devConsole__envField">

                <span>Server filename</span>

                <input
                    type="text"
                    value={filenameOverride}
                    onChange={(event) => setFilenameOverride(event.target.value)}
                    placeholder="10_brandname.png"
                    required
                />

            </label>

            {error && (

                <p className="devConsole__envError" role="alert">{error}</p>

            )}

            {success && (

                <p className="devConsole__envSuccess" role="status">{success}</p>

            )}

            <button
                type="submit"
                className="devConsole__envSubmit"
                disabled={busy || !file}
            >

                {busy ? "Uploading…" : "Upload Banner"}

            </button>

        </form>

    );

}

function CreateCampaignForm({ token, initialFilename = "", onCreated }) {

    const [advertiserName, setAdvertiserName] = useState("");
    const [filename, setFilename] = useState(initialFilename);
    const [destinationUrl, setDestinationUrl] = useState("");
    const [priority, setPriority] = useState("");
    const [expiresAt, setExpiresAt] = useState("");
    const [file, setFile] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [success, setSuccess] = useState("");

    useEffect(() => {

        if (initialFilename) {

            setFilename(initialFilename);

        }

    }, [initialFilename]);

    const submit = useCallback(async (event) => {

        event.preventDefault();
        setError("");
        setSuccess("");

        const expiresIso = toIsoFromDatetimeLocal(expiresAt);

        if (!expiresIso) {

            setError("expiresAt is required.");

            return;

        }

        if (priority === "" || !Number.isFinite(Number(priority))) {

            setError("priority is required.");

            return;

        }

        setBusy(true);

        try {

            const payload = {
                advertiserName: advertiserName.trim(),
                filename: filename.trim(),
                destinationUrl: destinationUrl.trim(),
                priority: Number(priority),
                expiresAt: expiresIso
            };

            if (file) {

                payload.contentBase64 = await readFileAsBase64(file);

                if (!payload.filename) {

                    payload.filename = file.name;

                }

            }

            const created = await createAdvertisement(token, payload);

            setSuccess(`Created campaign ${created.id}`);
            setAdvertiserName("");
            setDestinationUrl("");
            setPriority("");
            setExpiresAt("");
            setFile(null);
            onCreated?.(created);

        } catch (err) {

            setError(err.message || "Create failed");

        } finally {

            setBusy(false);

        }

    }, [
        advertiserName,
        destinationUrl,
        expiresAt,
        file,
        filename,
        onCreated,
        priority,
        token
    ]);

    return (

        <form className="devConsole__envForm" onSubmit={submit}>

            <h3 className="devConsole__sectionTitle">Create Campaign</h3>

            <p className="devConsole__envHint">

                Manual owner workflow: upload a banner first, or attach a file
                here so the campaign is created with the asset in one step.

            </p>

            <label className="devConsole__envField">

                <span>Advertiser name</span>

                <input
                    type="text"
                    value={advertiserName}
                    onChange={(event) => setAdvertiserName(event.target.value)}
                    required
                />

            </label>

            <label className="devConsole__envField">

                <span>Filename</span>

                <input
                    type="text"
                    value={filename}
                    onChange={(event) => setFilename(event.target.value)}
                    placeholder="10_brandname.png"
                    required
                />

            </label>

            <label className="devConsole__envField">

                <span>Destination URL</span>

                <input
                    type="url"
                    value={destinationUrl}
                    onChange={(event) => setDestinationUrl(event.target.value)}
                    placeholder="https://example.com"
                    required
                />

            </label>

            <label className="devConsole__envField">

                <span>Priority</span>

                <input
                    type="number"
                    min="0"
                    step="1"
                    value={priority}
                    onChange={(event) => setPriority(event.target.value)}
                    required
                />

            </label>

            <label className="devConsole__envField">

                <span>Expires at</span>

                <input
                    type="datetime-local"
                    value={expiresAt}
                    onChange={(event) => setExpiresAt(event.target.value)}
                    required
                />

            </label>

            <label className="devConsole__envField">

                <span>Banner file (optional if already uploaded)</span>

                <input
                    type="file"
                    accept=".jpg,.jpeg,.png,.webp,.gif,image/jpeg,image/png,image/webp,image/gif"
                    onChange={(event) => {

                        const next = event.target.files?.[0] ?? null;

                        setFile(next);

                        if (next && !filename.trim()) {

                            setFilename(next.name);

                        }

                    }}
                />

            </label>

            {error && (

                <p className="devConsole__envError" role="alert">{error}</p>

            )}

            {success && (

                <p className="devConsole__envSuccess" role="status">{success}</p>

            )}

            <button
                type="submit"
                className="devConsole__envSubmit"
                disabled={busy}
            >

                {busy ? "Creating…" : "Create Campaign"}

            </button>

        </form>

    );

}

function EditCampaignForm({ token, campaign, onSaved }) {

    const [advertiserName, setAdvertiserName] = useState(
        campaign.advertiserName ?? ""
    );
    const [destinationUrl, setDestinationUrl] = useState(
        campaign.destinationUrl ?? ""
    );
    const [priority, setPriority] = useState(
        campaign.priority != null ? String(campaign.priority) : ""
    );
    const [expiresAt, setExpiresAt] = useState(
        toDatetimeLocalValue(campaign.expiresAt)
    );
    const [status, setStatus] = useState(campaign.status ?? "ACTIVE");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [success, setSuccess] = useState("");

    useEffect(() => {

        setAdvertiserName(campaign.advertiserName ?? "");
        setDestinationUrl(campaign.destinationUrl ?? "");
        setPriority(campaign.priority != null ? String(campaign.priority) : "");
        setExpiresAt(toDatetimeLocalValue(campaign.expiresAt));
        setStatus(campaign.status ?? "ACTIVE");
        setError("");
        setSuccess("");

    }, [campaign]);

    const submit = useCallback(async (event) => {

        event.preventDefault();
        setError("");
        setSuccess("");
        setBusy(true);

        try {

            const updated = await updateAdvertisement(token, campaign.id, {
                advertiserName: advertiserName.trim(),
                destinationUrl: destinationUrl.trim(),
                priority: Number(priority),
                expiresAt: toIsoFromDatetimeLocal(expiresAt),
                status
            });

            setSuccess("Campaign updated.");
            onSaved?.(updated);

        } catch (err) {

            setError(err.message || "Update failed");

        } finally {

            setBusy(false);

        }

    }, [
        advertiserName,
        campaign.id,
        destinationUrl,
        expiresAt,
        onSaved,
        priority,
        status,
        token
    ]);

    return (

        <form className="devConsole__envForm" onSubmit={submit}>

            <h3 className="devConsole__sectionTitle">Edit Campaign</h3>

            <label className="devConsole__envField">

                <span>Advertiser name</span>

                <input
                    type="text"
                    value={advertiserName}
                    onChange={(event) => setAdvertiserName(event.target.value)}
                    required
                />

            </label>

            <label className="devConsole__envField">

                <span>Destination URL</span>

                <input
                    type="url"
                    value={destinationUrl}
                    onChange={(event) => setDestinationUrl(event.target.value)}
                    required
                />

            </label>

            <label className="devConsole__envField">

                <span>Priority</span>

                <input
                    type="number"
                    min="0"
                    step="1"
                    value={priority}
                    onChange={(event) => setPriority(event.target.value)}
                    required
                />

            </label>

            <label className="devConsole__envField">

                <span>Expires at</span>

                <input
                    type="datetime-local"
                    value={expiresAt}
                    onChange={(event) => setExpiresAt(event.target.value)}
                />

            </label>

            <label className="devConsole__envField">

                <span>Status</span>

                <select
                    value={status}
                    onChange={(event) => setStatus(event.target.value)}
                >

                    {STATUS_EDIT_OPTIONS.map((option) => (

                        <option key={option.value} value={option.value}>

                            {option.label}

                        </option>

                    ))}

                </select>

            </label>

            {error && (

                <p className="devConsole__envError" role="alert">{error}</p>

            )}

            {success && (

                <p className="devConsole__envSuccess" role="status">{success}</p>

            )}

            <button
                type="submit"
                className="devConsole__envSubmit"
                disabled={busy}
            >

                {busy ? "Saving…" : "Save Changes"}

            </button>

        </form>

    );

}

function CampaignLifecycleActions({ token, campaign, onChanged, onDeleted }) {

    const [renewExpiresAt, setRenewExpiresAt] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [success, setSuccess] = useState("");

    const runAction = useCallback(async (action, successMessage = "Campaign updated.") => {

        setError("");
        setSuccess("");
        setBusy(true);

        try {

            const result = await action();

            setSuccess(successMessage);
            onChanged?.(result);

        } catch (err) {

            setError(err.message || "Action failed");

        } finally {

            setBusy(false);

        }

    }, [onChanged]);

    const onDisable = useCallback(() => {

        const confirmed = window.confirm(
            `Disable campaign ${campaign.id}?\n\n`
            + "It will stop rotating until re-enabled."
        );

        if (!confirmed) {

            return;

        }

        runAction(() => disableAdvertisement(token, campaign.id));

    }, [campaign.id, runAction, token]);

    const onEnable = useCallback(() => {

        const confirmed = window.confirm(
            `Enable campaign ${campaign.id}?\n\n`
            + "Status will be set to ACTIVE."
        );

        if (!confirmed) {

            return;

        }

        runAction(() => updateAdvertisement(token, campaign.id, {
            status: "ACTIVE"
        }));

    }, [campaign.id, runAction, token]);

    const onRenew = useCallback(() => {

        const expiresAt = toIsoFromDatetimeLocal(renewExpiresAt);

        if (!expiresAt) {

            setError("Renewal requires a new expiresAt value.");

            return;

        }

        const confirmed = window.confirm(
            `Renew campaign ${campaign.id}?\n\n`
            + `New expiration: ${expiresAt}`
        );

        if (!confirmed) {

            return;

        }

        runAction(() => renewAdvertisement(token, campaign.id, { expiresAt }));

    }, [campaign.id, renewExpiresAt, runAction, token]);

    const onDelete = useCallback(async () => {

        const confirmed = window.confirm(
            `Delete campaign ${campaign.id}?\n\n`
            + "The campaign and its banner asset will be permanently removed."
            + " A history snapshot is preserved on the server."
        );

        if (!confirmed) {

            return;

        }

        setError("");
        setSuccess("");
        setBusy(true);

        try {

            await deleteAdvertisement(token, campaign.id);

            setSuccess("Campaign deleted.");
            onDeleted?.();

        } catch (err) {

            setError(err.message || "Delete failed");

        } finally {

            setBusy(false);

        }

    }, [campaign.id, onDeleted, token]);

    return (

        <div className="devConsole__envSection">

            <h3 className="devConsole__sectionTitle">Lifecycle Controls</h3>

            <div className="devConsole__detailActions">

                {campaign.status !== "ACTIVE" && (

                    <button
                        type="button"
                        className="devConsole__button"
                        disabled={busy}
                        onClick={onEnable}
                    >

                        Enable

                    </button>

                )}

                {campaign.status !== "DISABLED" && (

                    <button
                        type="button"
                        className="devConsole__textButton"
                        disabled={busy}
                        onClick={onDisable}
                    >

                        Disable

                    </button>

                )}

                <button
                    type="button"
                    className="devConsole__textButton"
                    disabled={busy}
                    onClick={onDelete}
                >

                    Delete

                </button>

            </div>

            <label className="devConsole__envField">

                <span>Renew expires at</span>

                <input
                    type="datetime-local"
                    value={renewExpiresAt}
                    onChange={(event) => setRenewExpiresAt(event.target.value)}
                />

            </label>

            <button
                type="button"
                className="devConsole__envSubmit"
                disabled={busy || !renewExpiresAt}
                onClick={onRenew}
            >

                {busy ? "Working…" : "Renew Campaign"}

            </button>

            {error && (

                <p className="devConsole__envError" role="alert">{error}</p>

            )}

            {success && (

                <p className="devConsole__envSuccess" role="status">{success}</p>

            )}

        </div>

    );

}

export default function AdvertisingPanel() {

    const {
        accessToken,
        authEnabled,
        canManageConsole: canManage,
        session,
        status: authStatus
    } = useDeveloperAuth();

    const token = authEnabled ? accessToken : null;

    const [search, setSearch] = useState("");
    const [statusFilter, setStatusFilter] = useState("all");
    const [listData, setListData] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [selectedId, setSelectedId] = useState(null);
    const [detail, setDetail] = useState(null);
    const [detailLoading, setDetailLoading] = useState(false);
    const [detailError, setDetailError] = useState("");
    const [uploadedFilename, setUploadedFilename] = useState("");

    const refresh = useCallback(async () => {

        setLoading(true);
        setError("");

        try {

            const next = await listAdvertisements(token);

            setListData(next);

        } catch (err) {

            setError(err.message || "Failed to load advertisements");
            setListData(null);

        } finally {

            setLoading(false);

        }

    }, [token]);

    const refreshDetail = useCallback(async (id) => {

        if (!id) {

            return null;

        }

        const record = await getAdvertisement(token, id);

        setDetail(record);
        setDetailError("");

        return record;

    }, [token]);

    useEffect(() => {

        refresh();

    }, [refresh]);

    useEffect(() => {

        if (!selectedId) {

            setDetail(null);
            setDetailError("");

            return;

        }

        let cancelled = false;

        setDetailLoading(true);
        setDetailError("");

        getAdvertisement(token, selectedId)
            .then((record) => {

                if (!cancelled) {

                    setDetail(record);

                }

            })
            .catch((err) => {

                if (!cancelled) {

                    setDetail(null);
                    setDetailError(err.message || "Failed to load campaign");

                }

            })
            .finally(() => {

                if (!cancelled) {

                    setDetailLoading(false);

                }

            });

        return () => {

            cancelled = true;

        };

    }, [selectedId, token]);

    const campaigns = useMemo(
        () => listData?.campaigns ?? [],
        [listData]
    );
    const storage = listData?.storage ?? null;

    const filtered = useMemo(() => {

        const query = search.trim().toLowerCase();

        return campaigns.filter((campaign) => {

            if (statusFilter !== "all" && campaign.status !== statusFilter) {

                return false;

            }

            if (!query) {

                return true;

            }

            return [
                campaign.id,
                campaign.filename,
                campaign.advertiserName,
                campaign.status
            ].some((value) => String(value ?? "").toLowerCase().includes(query));

        });

    }, [campaigns, search, statusFilter]);

    const statusOptions = useMemo(() => {

        const statuses = [
            ...new Set(campaigns.map((campaign) => campaign.status).filter(Boolean))
        ];

        return [
            { value: "all", label: "All statuses" },
            ...statuses.map((entry) => ({ value: entry, label: entry }))
        ];

    }, [campaigns]);

    const tableRows = filtered.map((campaign) => ({

        id: campaign.id,
        data: campaign,
        className: "devConsole__historyRow",
        onClick: () => setSelectedId(
            campaign.id === selectedId ? null : campaign.id
        )

    }));

    const listColumns = [
        {
            key: "id",
            label: "ID",
            render: (row) => shortId(row.id, 14)
        },
        {
            key: "filename",
            label: "Filename"
        },
        {
            key: "advertiserName",
            label: "Advertiser",
            render: (row) => row.advertiserName || "—"
        },
        {
            key: "priority",
            label: "Priority"
        },
        {
            key: "status",
            label: "Status",
            render: (row) => (
                <StatusBadge tone={campaignStatusTone(row.status)}>
                    {row.status ?? "—"}
                </StatusBadge>
            )
        },
        {
            key: "createdAt",
            label: "Created At",
            render: (row) => formatIsoTimestamp(row.createdAt)
        },
        {
            key: "expiresAt",
            label: "Expires At",
            render: (row) => formatIsoTimestamp(row.expiresAt)
        }
    ];

    const onCampaignMutated = useCallback(async (campaign) => {

        await refresh();

        if (campaign?.id) {

            setSelectedId(campaign.id);
            await refreshDetail(campaign.id);

        }

    }, [refresh, refreshDetail]);

    // R18.0-prep — after deletion: refresh list, clear the deleted selection.
    const onCampaignDeleted = useCallback(async () => {

        setSelectedId(null);
        setDetail(null);
        await refresh();

    }, [refresh]);

    return (

        <PanelShell
            title="Advertising"
            subtitle={
                canManage
                    ? "Manual owner administration — upload, create, edit, enable, disable, renew"
                    : "Read-only campaign visibility"
            }
            actions={(
                <button
                    type="button"
                    className="devConsole__textButton"
                    onClick={refresh}
                    disabled={loading}
                >

                    Refresh

                </button>
            )}
        >

            <StatGrid>

                <StatCard
                    label="Campaigns"
                    value={loading && !listData ? "…" : campaigns.length}
                />

                <StatCard
                    label="Storage Used"
                    value={
                        storage?.usedBytes != null
                            ? formatBytes(storage.usedBytes)
                            : "—"
                    }
                />

                <StatCard
                    label="History Records"
                    value={storage?.historyCount ?? "—"}
                />

            </StatGrid>

            <div className="devConsole__envSection" role="status">

                <p className="devConsole__envHint">

                    {canManage
                        ? (
                            authStatus === "open" || !authEnabled
                                ? "Open console access — administrator management enabled."
                                : `Signed in as ${session?.role ?? "Administrator"}`
                                + " — management controls are visible below."
                        )
                        : `Signed in as ${session?.role ?? "Viewer"}`
                        + " — read-only access. Sign in with an Administrator account"
                        + " to upload banners and manage campaigns."}

                </p>

            </div>

            {canManage && (

                <section className="devConsole__envSection" aria-label="Manage Campaigns">

                    <h3 className="devConsole__envSectionTitle">

                        Manage Campaigns

                    </h3>

                    <p className="devConsole__envHint">

                        Manual owner workflow: advertiser pays offline, then the
                        owner uploads the banner and activates the campaign here.

                    </p>

                    <UploadBannerForm
                        token={token}
                        onUploaded={(uploaded) => {

                            setUploadedFilename(uploaded.filename);
                            refresh();

                        }}
                    />

                    <CreateCampaignForm
                        token={token}
                        initialFilename={uploadedFilename}
                        onCreated={onCampaignMutated}
                    />

                    {detail ? (

                        <>

                            <h3 className="devConsole__sectionTitle">

                                Selected Campaign Actions

                            </h3>

                            <EditCampaignForm
                                token={token}
                                campaign={detail}
                                onSaved={onCampaignMutated}
                            />

                            <CampaignLifecycleActions
                                token={token}
                                campaign={detail}
                                onChanged={onCampaignMutated}
                                onDeleted={onCampaignDeleted}
                            />

                        </>

                    ) : (

                        <EmptyState
                            title="Select a campaign for edit and lifecycle actions"
                            detail="Choose a row in Campaign List below to edit URL, priority, status, or renew."
                        />

                    )}

                </section>

            )}

            {!canManage && (

                <p className="devConsole__envHint">

                    Viewer accounts may inspect campaigns but cannot create,
                    upload, edit, disable, or renew advertisements.

                </p>

            )}

            <section className="devConsole__envSection" aria-label="Campaign List">

                <h3 className="devConsole__envSectionTitle">

                    Campaign List

                </h3>

                <Toolbar
                    search={search}
                    onSearchChange={setSearch}
                    searchPlaceholder="Search id, filename, advertiser…"
                >

                    <FilterSelect
                        label="Status"
                        value={statusFilter}
                        onChange={setStatusFilter}
                        options={statusOptions}
                    />

                </Toolbar>

                {error && (

                    <p className="devConsole__loginError" role="alert">

                        {error}

                    </p>

                )}

                {loading && !listData && !error ? (

                    <EmptyState title="Loading advertisement campaigns…" />

                ) : campaigns.length === 0 && !error ? (

                    <EmptyState
                        title="No advertisement campaigns"
                        detail={
                        canManage
                            ? "Use Manage Campaigns above to upload a banner and create the first campaign."
                            : "Uploaded campaigns will appear here once created on the server."
                        }
                    />

                ) : (

                    <DataTable
                        columns={listColumns}
                        rows={tableRows}
                        empty="No campaigns match the current filters."
                    />

                )}

                {selectedId && (

                    <div className="devConsole__detailStack">

                        <div className="devConsole__detailActions">

                            <h3 className="devConsole__sectionTitle">

                                Campaign Details

                            </h3>

                            <button
                                type="button"
                                className="devConsole__textButton"
                                onClick={() => setSelectedId(null)}
                            >

                                Clear selection

                            </button>

                        </div>

                        {detailLoading && !detail && !detailError && (

                            <EmptyState title="Loading campaign details…" />

                        )}

                        {detailError && (

                            <p className="devConsole__loginError" role="alert">

                                {detailError}

                            </p>

                        )}

                        {detail && (

                            <KeyValueList entries={buildDetailEntries(detail)} />

                        )}

                    </div>

                )}

            </section>

        </PanelShell>

    );

}

