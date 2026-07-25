import { useMemo, useState } from "react";

import { useConsoleProjection } from "../ConsoleStreamProvider";
import { formatClockTime, shortId } from "../formatters";
import PanelShell from "./shared/PanelShell";
import Toolbar, { FilterSelect } from "./shared/Toolbar";
import { DataTable } from "./shared/DataTable";
import EmptyState from "./shared/EmptyState";

export default function TimelinePanel() {

    const timeline = useConsoleProjection("timeline");
    const [search, setSearch] = useState("");
    const [kindFilter, setKindFilter] = useState("all");

    const entries = timeline ?? [];

    const kinds = useMemo(() => {

        const set = new Set(entries.map((entry) => entry.kind).filter(Boolean));

        return [
            { value: "all", label: "All kinds" },
            ...[...set].map((kind) => ({ value: kind, label: kind }))
        ];

    }, [entries]);

    const filtered = useMemo(() => {

        const query = search.trim().toLowerCase();

        return entries.filter((entry) => {

            if (kindFilter !== "all" && entry.kind !== kindFilter) {

                return false;

            }

            if (!query) {

                return true;

            }

            return [
                entry.roomId,
                entry.gameId,
                entry.kind,
                entry.summary
            ].some((value) => String(value ?? "").toLowerCase().includes(query));

        });

    }, [entries, search, kindFilter]);

    return (

        <PanelShell
            title="Timeline"
            subtitle="Chronological room history (newest first)"
        >

            <Toolbar
                search={search}
                onSearchChange={setSearch}
                searchPlaceholder="Filter timeline…"
            >

                <FilterSelect
                    label="Kind"
                    value={kindFilter}
                    onChange={setKindFilter}
                    options={kinds}
                />

            </Toolbar>

            {filtered.length === 0 ? (

                <EmptyState
                    title="No timeline events yet"
                    detail="Room create/update/remove events appear as the rooms index changes."
                />

            ) : (

                <DataTable
                    columns={[
                        {
                            key: "at",
                            label: "Time",
                            render: (entry) => formatClockTime(entry.at)
                        },
                        { key: "kind", label: "Kind" },
                        {
                            key: "roomId",
                            label: "Room",
                            render: (entry) => shortId(entry.roomId, 12)
                        },
                        {
                            key: "gameId",
                            label: "Game",
                            render: (entry) => shortId(entry.gameId, 10)
                        },
                        { key: "summary", label: "Summary" }
                    ]}
                    rows={filtered.map((entry, index) => ({
                        id: `${entry.at}-${entry.roomId}-${index}`,
                        data: entry
                    }))}
                />

            )}

        </PanelShell>

    );

}
