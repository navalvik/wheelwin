import { useConsoleProjection } from "../ConsoleStreamProvider";
import PanelShell from "./shared/PanelShell";
import { StatCard, StatGrid } from "./shared/StatGrid";
import EmptyState from "./shared/EmptyState";

/**
 * R8.0E — Launch Readiness panel (read-only projection).
 */
export default function LaunchReadinessPanel() {

    const server = useConsoleProjection("server");

    const launch = server?.launch;

    if (!server) {

        return (

            <PanelShell title="Launch Readiness">

                <EmptyState title="Waiting for launch overview" />

            </PanelShell>

        );

    }

    if (!launch) {

        return (

            <PanelShell
                title="Launch Readiness"
                subtitle="Open Beta / GA / Production gates — observational only"
            >

                <EmptyState title="Launch status unavailable" />

            </PanelShell>

        );

    }

    return (

        <PanelShell
            title="Launch Readiness"
            subtitle="Entry gates and launch decision — no sensitive details"
        >

            <StatGrid>

                <StatCard
                    label="Current Release"
                    value={launch.rcVersion
                        ?? server.release?.version
                        ?? server.version
                        ?? "—"}
                />

                <StatCard
                    label="Lifecycle"
                    value={launch.lifecycle ?? "—"}
                />

                <StatCard
                    label="Launch Decision"
                    value={launch.decision ?? "—"}
                    hint={launch.decisionReason}
                    tone={launch.decision === "BLOCKED"
                        ? "red"
                        : launch.productionReady
                            ? "green"
                            : launch.openBetaReady
                                ? "yellow"
                                : undefined}
                />

                <StatCard
                    label="Readiness Score"
                    value={launch.readinessScore ?? "—"}
                />

                <StatCard
                    label="Open Beta"
                    value={launch.openBetaReady ? "READY" : "NOT READY"}
                    hint={launch.openBetaScore != null
                        ? `Score ${launch.openBetaScore}`
                        : undefined}
                    tone={launch.openBetaReady ? "green" : "yellow"}
                />

                <StatCard
                    label="GA Readiness"
                    value={launch.gaReady ? "READY" : "NOT READY"}
                    tone={launch.gaReady ? "green" : undefined}
                />

                <StatCard
                    label="Production"
                    value={launch.productionReady ? "READY" : "NOT READY"}
                    hint={launch.productionScore != null
                        ? `Score ${launch.productionScore}`
                        : undefined}
                    tone={launch.productionReady ? "green" : undefined}
                />

                <StatCard
                    label="Gates Passed"
                    value={launch.gateSummary
                        ? `${launch.gateSummary.passed}/${launch.gateSummary.total}`
                        : "—"}
                    hint={launch.gateSummary?.passRate != null
                        ? `Pass rate ${Math.round(launch.gateSummary.passRate * 100)}%`
                        : undefined}
                />

                <StatCard
                    label="Critical Blockers"
                    value={launch.blockerSummary?.critical ?? 0}
                    tone={(launch.blockerSummary?.critical ?? 0) > 0
                        ? "red"
                        : "green"}
                />

                <StatCard
                    label="High Blockers"
                    value={launch.blockerSummary?.high ?? 0}
                    tone={(launch.blockerSummary?.high ?? 0) > 0
                        ? "yellow"
                        : undefined}
                />

                <StatCard
                    label="Docs Completeness"
                    value={launch.documentationCompleteness != null
                        ? `${Math.round(launch.documentationCompleteness * 100)}%`
                        : "—"}
                />

                <StatCard
                    label="Evidence"
                    value={launch.evidenceHash ?? "—"}
                />

            </StatGrid>

        </PanelShell>

    );

}
