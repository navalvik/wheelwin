import { useCallback, useEffect, useMemo, useState } from "react";

import { useDeveloperAuth } from "../DeveloperAuthProvider";
import {
    getAdvertisement,
    listAdvertisements
} from "../developerAuthApi";
import { formatBytes, shortId } from "../formatters";
import PanelShell from "./shared/PanelShell";
import Toolbar, { FilterSelect } from "./shared/Toolbar";
import { DataTable, KeyValueList } from "./shared/DataTable";
import EmptyState from "./shared/EmptyState";
import { StatCard, StatGrid } from "./shared/StatGrid";
import { StatusBadge } from "./shared/StatusDot";

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

export default function AdvertisingPanel() {

    const { accessToken, authEnabled } = useDeveloperAuth();
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

        setDetail(null);
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

    const campaigns = listData?.campaigns ?? [];
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
            ...statuses.map((status) => ({ value: status, label: status }))
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

    return (

        <PanelShell
            title="Advertising"
            subtitle="Read-only campaign visibility — no mutations in this view"
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
                    detail="Uploaded campaigns will appear here once created on the server."
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

        </PanelShell>

    );

}
