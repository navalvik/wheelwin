import { useConsoleProjection } from "../ConsoleStreamProvider";
import PanelShell from "./shared/PanelShell";
import { StatCard, StatGrid } from "./shared/StatGrid";
import EmptyState from "./shared/EmptyState";

/**
 * R9.0B — Post-Launch Operations panel (read-only).
 */
export default function PostLaunchOperationsPanel() {

    const server = useConsoleProjection("server");

    const ops = server?.operations;

    if (!server) {

        return (

            <PanelShell title="Post-Launch Operations">

                <EmptyState title="Waiting for operations overview" />

            </PanelShell>

        );

    }

    if (!ops) {

        return (

            <PanelShell
                title="Post-Launch Operations"
                subtitle="Continuous service supervision — observational only"
            >

                <EmptyState title="Operations status unavailable" />

            </PanelShell>

        );

    }

    return (

        <PanelShell
            title="Post-Launch Operations"
            subtitle="KPI, SLA, maintenance, and version lifecycle — no gameplay controls"
        >

            <StatGrid>

                <StatCard
                    label="Service State"
                    value={ops.lifecycle ?? "—"}
                />

                <StatCard
                    label="Current Version"
                    value={ops.currentVersion ?? "—"}
                    hint={ops.supportedVersions != null
                        ? `Supported ${ops.supportedVersions}`
                        : undefined}
                />

                <StatCard
                    label="Operational Score"
                    value={ops.operationalScore ?? "—"}
                />

                <StatCard
                    label="Availability"
                    value={ops.kpiSummary?.availability != null
                        ? `${Math.round(ops.kpiSummary.availability * 1000) / 10}%`
                        : "—"}
                />

                <StatCard
                    label="Avg Latency (ms)"
                    value={ops.kpiSummary?.averageLatencyMs ?? "—"}
                />

                <StatCard
                    label="SLA Score"
                    value={ops.slaSummary?.score ?? "—"}
                    hint={ops.slaSummary
                        ? `P${ops.slaSummary.passed}/W${ops.slaSummary.warned}/F${ops.slaSummary.failed}`
                        : undefined}
                    tone={(ops.slaSummary?.failed ?? 0) > 0
                        ? "red"
                        : (ops.slaSummary?.warned ?? 0) > 0
                            ? "yellow"
                            : "green"}
                />

                <StatCard
                    label="Maintenance"
                    value={ops.maintenanceState ?? "—"}
                    tone={ops.maintenanceActive ? "yellow" : undefined}
                />

                <StatCard
                    label="Incidents Open"
                    value={ops.incidentSummary?.open ?? 0}
                    hint={ops.incidentSummary?.openCritical != null
                        ? `Critical ${ops.incidentSummary.openCritical}`
                        : undefined}
                    tone={(ops.incidentSummary?.openCritical ?? 0) > 0
                        ? "red"
                        : undefined}
                />

                <StatCard
                    label="Trend Samples"
                    value={ops.trendSampleCount ?? 0}
                />

                <StatCard
                    label="Uptime (ms)"
                    value={ops.uptimeMs ?? 0}
                />

            </StatGrid>

        </PanelShell>

    );

}
