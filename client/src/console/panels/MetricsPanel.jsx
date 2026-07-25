import { useConsoleProjection } from "../ConsoleStreamProvider";
import { formatDurationMs, formatUptime } from "../formatters";
import PanelShell from "./shared/PanelShell";
import { StatCard, StatGrid } from "./shared/StatGrid";
import { DataTable } from "./shared/DataTable";
import EmptyState from "./shared/EmptyState";

function timingAverage(timings, key) {

    return timings?.[key]?.averageMs ?? null;

}

export default function MetricsPanel() {

    const metrics = useConsoleProjection("metrics");

    if (!metrics) {

        return (

            <PanelShell title="Metrics">

                <EmptyState title="Waiting for metrics overview" />

            </PanelShell>

        );

    }

    const counters = metrics.counters ?? {};
    const timings = metrics.timings ?? {};
    const runtime = metrics.runtime ?? {};

    const timingRows = Object.entries(timings).map(([name, record]) => ({
        id: name,
        data: { name, ...record }
    }));

    return (

        <PanelShell
            title="Metrics"
            subtitle={metrics.enabled ? "Enabled" : "Collector disabled / empty"}
        >

            <StatGrid>

                <StatCard
                    label="Active players"
                    value={runtime.activePlayers}
                />

                <StatCard
                    label="Games"
                    value={runtime.activeGames}
                    hint={`Started ${counters["games.started"] ?? 0}`}
                />

                <StatCard
                    label="Avg setup time"
                    value={formatDurationMs(
                        timingAverage(timings, "setup.duration")
                    )}
                />

                <StatCard
                    label="Avg payment time"
                    value={formatDurationMs(
                        timingAverage(timings, "payment.duration")
                    )}
                />

                <StatCard
                    label="Avg game time"
                    value={formatDurationMs(
                        timingAverage(timings, "game.duration")
                    )}
                />

                <StatCard
                    label="Avg settlement time"
                    value={formatDurationMs(
                        timingAverage(timings, "settlement.duration")
                    )}
                />

                <StatCard
                    label="Reconnects"
                    value={counters.reconnects ?? 0}
                />

                <StatCard
                    label="Uptime"
                    value={formatUptime(runtime.uptimeMs)}
                />

            </StatGrid>

            <h3 className="devConsole__sectionTitle">

                Timing samples

            </h3>

            <DataTable
                empty="No timing samples yet."
                columns={[
                    { key: "name", label: "Metric" },
                    { key: "count", label: "Count" },
                    {
                        key: "averageMs",
                        label: "Average",
                        render: (row) => formatDurationMs(row.averageMs)
                    },
                    {
                        key: "lastMs",
                        label: "Last",
                        render: (row) => formatDurationMs(row.lastMs)
                    }
                ]}
                rows={timingRows}
            />

            <h3 className="devConsole__sectionTitle">

                Counters

            </h3>

            <DataTable
                empty="No counters yet."
                columns={[
                    { key: "name", label: "Counter" },
                    { key: "value", label: "Value" }
                ]}
                rows={Object.entries(counters).map(([name, value]) => ({
                    id: name,
                    data: { name, value }
                }))}
            />

        </PanelShell>

    );

}
