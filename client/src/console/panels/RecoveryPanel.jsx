import { useMemo, useState } from "react";

import { useConsoleProjection } from "../ConsoleStreamProvider";
import { formatClockTime, shortId } from "../formatters";
import PanelShell from "./shared/PanelShell";
import { StatCard, StatGrid } from "./shared/StatGrid";
import Toolbar, { FilterSelect } from "./shared/Toolbar";
import { DataTable } from "./shared/DataTable";
import EmptyState from "./shared/EmptyState";

export default function RecoveryPanel() {

    const recovery = useConsoleProjection("recovery");
    const [bucket, setBucket] = useState("all");
    const [search, setSearch] = useState("");

    const rows = useMemo(() => {

        if (!recovery) {

            return [];

        }

        const active = (recovery.active ?? []).map((entry) => ({
            id: `active-${entry.gameId}`,
            bucket: "recovering",
            label: "Recovering",
            ref: entry.gameId,
            detail: entry.status,
            at: null
        }));

        const waiting = (recovery.waiting ?? []).map((entry, index) => ({
            id: `waiting-${entry.playerId ?? entry.gameId ?? index}`,
            bucket: "waiting",
            label: "Waiting",
            ref: entry.playerId ?? entry.gameId,
            detail: entry.status,
            at: entry.capturedAt ?? null
        }));

        const expired = recovery.expired > 0
            ? [{
                id: "expired-count",
                bucket: "expired",
                label: "Expired",
                ref: "—",
                detail: `${recovery.expired} tracked`,
                at: null
            }]
            : [];

        const all = [...active, ...waiting, ...expired];
        const query = search.trim().toLowerCase();

        return all.filter((row) => {

            if (bucket !== "all" && row.bucket !== bucket) {

                return false;

            }

            if (!query) {

                return true;

            }

            return [row.ref, row.detail, row.label]
                .some((value) => String(value ?? "").toLowerCase().includes(query));

        });

    }, [recovery, bucket, search]);

    if (!recovery) {

        return (

            <PanelShell title="Recovery">

                <EmptyState title="Waiting for recovery overview" />

            </PanelShell>

        );

    }

    return (

        <PanelShell title="Recovery">

            <StatGrid>

                <StatCard
                    label="Recovering"
                    value={recovery.activeRecoveries}
                    tone="yellow"
                />

                <StatCard
                    label="Waiting"
                    value={recovery.waitingReconnect}
                    tone="yellow"
                />

                <StatCard
                    label="Expired"
                    value={recovery.expired}
                />

                <StatCard
                    label="Cache entries"
                    value={recovery.cacheCount}
                />

            </StatGrid>

            <Toolbar
                search={search}
                onSearchChange={setSearch}
                searchPlaceholder="Search recovery refs…"
            >

                <FilterSelect
                    label="Bucket"
                    value={bucket}
                    onChange={setBucket}
                    options={[
                        { value: "all", label: "All" },
                        { value: "recovering", label: "Recovering" },
                        { value: "waiting", label: "Waiting" },
                        { value: "expired", label: "Expired" }
                    ]}
                />

            </Toolbar>

            <DataTable
                empty="No recovery rows."
                columns={[
                    { key: "label", label: "Status" },
                    {
                        key: "ref",
                        label: "Ref",
                        render: (row) => shortId(row.ref, 14)
                    },
                    { key: "detail", label: "Detail" },
                    {
                        key: "at",
                        label: "Reconnect timer / captured",
                        render: (row) => (
                            row.at != null
                                ? formatClockTime(row.at)
                                : "—"
                        )
                    }
                ]}
                rows={rows.map((row) => ({
                    id: row.id,
                    data: row
                }))}
            />

        </PanelShell>

    );

}
