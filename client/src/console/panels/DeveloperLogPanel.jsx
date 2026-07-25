import { useMemo, useState } from "react";

import { useConsoleProjection } from "../ConsoleStreamProvider";
import { formatClockTime } from "../formatters";
import PanelShell from "./shared/PanelShell";
import Toolbar, { FilterSelect } from "./shared/Toolbar";
import { DataTable } from "./shared/DataTable";
import EmptyState from "./shared/EmptyState";

const MAX_VISIBLE = 500;

export default function DeveloperLogPanel() {

    const logs = useConsoleProjection("logs") ?? [];
    const [search, setSearch] = useState("");
    const [severity, setSeverity] = useState("all");

    const filtered = useMemo(() => {

        const query = search.trim().toLowerCase();

        return [...logs]
            .reverse()
            .filter((entry) => {

                const level = String(entry.level ?? "info").toLowerCase();

                if (severity !== "all" && level !== severity) {

                    return false;

                }

                if (!query) {

                    return true;

                }

                return [
                    entry.message,
                    entry.source,
                    entry.level
                ].some((value) => String(value ?? "").toLowerCase().includes(query));

            })
            .slice(0, MAX_VISIBLE);

    }, [logs, search, severity]);

    return (

        <PanelShell
            title="Developer Log"
            subtitle={`Showing ${filtered.length} · buffer ${logs.length}/${MAX_VISIBLE}`}
        >

            <Toolbar
                search={search}
                onSearchChange={setSearch}
                searchPlaceholder="Search message or source…"
            >

                <FilterSelect
                    label="Severity"
                    value={severity}
                    onChange={setSeverity}
                    options={[
                        { value: "all", label: "All" },
                        { value: "info", label: "Info" },
                        { value: "warn", label: "Warn" },
                        { value: "error", label: "Error" }
                    ]}
                />

            </Toolbar>

            {filtered.length === 0 ? (

                <EmptyState title="No log entries" />

            ) : (

                <DataTable
                    columns={[
                        {
                            key: "at",
                            label: "Time",
                            render: (entry) => formatClockTime(entry.at)
                        },
                        {
                            key: "level",
                            label: "Severity",
                            render: (entry) => (
                                <span
                                    className={
                                        `devConsole__logLevel devConsole__logLevel--${
                                            String(entry.level ?? "info").toLowerCase()
                                        }`
                                    }
                                >

                                    {String(entry.level ?? "info").toUpperCase()}

                                </span>
                            )
                        },
                        {
                            key: "source",
                            label: "Source",
                            render: (entry) => entry.source ?? "console"
                        },
                        {
                            key: "message",
                            label: "Message",
                            render: (entry) => entry.message ?? "—"
                        }
                    ]}
                    rows={filtered.map((entry, index) => ({
                        id: `${entry.at}-${index}`,
                        data: {
                            ...entry,
                            source: entry.source ?? "DeveloperConsoleGateway"
                        }
                    }))}
                />

            )}

        </PanelShell>

    );

}
