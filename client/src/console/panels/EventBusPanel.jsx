import { useConsoleProjection } from "../ConsoleStreamProvider";
import PanelShell from "./shared/PanelShell";
import { StatCard, StatGrid } from "./shared/StatGrid";
import { DataTable } from "./shared/DataTable";
import EmptyState from "./shared/EmptyState";

/**
 * R6.0E — Event Bus view composed from metrics counters / timings
 * (no dedicated EventBus projection in this stage).
 */
export default function EventBusPanel() {

    const metrics = useConsoleProjection("metrics");
    const logs = useConsoleProjection("logs") ?? [];

    if (!metrics) {

        return (

            <PanelShell title="Event Bus">

                <EmptyState title="Waiting for metrics stream" />

            </PanelShell>

        );

    }

    const counters = Object.entries(metrics.counters ?? {});
    const recent = [...logs].reverse().slice(0, 20);

    return (

        <PanelShell
            title="Event Bus"
            subtitle="Activity inferred from operational counters"
        >

            <StatGrid>

                <StatCard
                    label="Counter keys"
                    value={counters.length}
                />

                <StatCard
                    label="Timing keys"
                    value={Object.keys(metrics.timings ?? {}).length}
                />

                <StatCard
                    label="Health"
                    value={metrics.runtime?.healthStatus ?? "—"}
                />

            </StatGrid>

            <h3 className="devConsole__sectionTitle">

                Operational counters

            </h3>

            <DataTable
                empty="No counter activity yet."
                columns={[
                    { key: "name", label: "Event / counter" },
                    { key: "value", label: "Count" }
                ]}
                rows={counters.map(([name, value]) => ({
                    id: name,
                    data: { name, value }
                }))}
            />

            <h3 className="devConsole__sectionTitle">

                Recent console log traffic

            </h3>

            <DataTable
                empty="No recent logs."
                columns={[
                    { key: "message", label: "Message" }
                ]}
                rows={recent.map((entry, index) => ({
                    id: `${entry.at}-${index}`,
                    data: entry
                }))}
            />

        </PanelShell>

    );

}
