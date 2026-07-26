import { useConsoleProjection } from "../ConsoleStreamProvider";
import PanelShell from "./shared/PanelShell";
import { StatCard, StatGrid } from "./shared/StatGrid";
import EmptyState from "./shared/EmptyState";

/**
 * R8.0D — Closed Beta operations panel (read-only projection).
 */
export default function ClosedBetaPanel() {

    const server = useConsoleProjection("server");

    const beta = server?.closedBeta;

    if (!server) {

        return (

            <PanelShell title="Closed Beta">

                <EmptyState title="Waiting for Closed Beta overview" />

            </PanelShell>

        );

    }

    if (!beta) {

        return (

            <PanelShell
                title="Closed Beta"
                subtitle="Operations & telemetry — observational only"
            >

                <EmptyState title="Closed Beta status unavailable" />

            </PanelShell>

        );

    }

    return (

        <PanelShell
            title="Closed Beta"
            subtitle="Participant, telemetry, feedback, and readiness — no PII"
        >

            <StatGrid>

                <StatCard
                    label="RC Version"
                    value={beta.rcVersion
                        ?? server.release?.version
                        ?? server.version
                        ?? "—"}
                />

                <StatCard
                    label="Lifecycle"
                    value={beta.lifecycle ?? "—"}
                />

                <StatCard
                    label="Readiness"
                    value={beta.readiness ?? "—"}
                    hint={beta.readinessScore != null
                        ? `Score ${beta.readinessScore}`
                        : undefined}
                />

                <StatCard
                    label="Certification"
                    value={beta.certificationStatus
                        ?? server.certification?.status
                        ?? "—"}
                    hint={beta.certificationBetaReady
                        ? "Beta ready"
                        : undefined}
                />

                <StatCard
                    label="Participants"
                    value={beta.participantCount ?? 0}
                    hint={beta.participants?.active != null
                        ? `Active ${beta.participants.active}`
                        : undefined}
                />

                <StatCard
                    label="Active Sessions"
                    value={beta.activeSessions ?? 0}
                />

                <StatCard
                    label="Feedback"
                    value={beta.feedbackCount ?? 0}
                    hint={beta.feedback?.bySeverity?.CRITICAL != null
                        ? `Critical ${beta.feedback.bySeverity.CRITICAL}`
                        : undefined}
                />

                <StatCard
                    label="Incidents"
                    value={beta.incidentCount ?? 0}
                    hint={beta.incidents?.openCritical != null
                        ? `Open critical ${beta.incidents.openCritical}`
                        : undefined}
                />

                <StatCard
                    label="Crashes"
                    value={beta.crashCount ?? 0}
                    hint={beta.crashRate != null
                        ? `Rate ${beta.crashRate}`
                        : undefined}
                />

                <StatCard
                    label="Games Completed"
                    value={beta.telemetry?.gamesCompleted ?? 0}
                />

                <StatCard
                    label="Avg Latency (ms)"
                    value={beta.telemetry?.averageLatencyMs ?? 0}
                />

                <StatCard
                    label="Payment Success"
                    value={beta.telemetry?.settlementSuccessRate != null
                        ? `${Math.round(
                            beta.telemetry.settlementSuccessRate * 100
                        )}%`
                        : "—"}
                />

            </StatGrid>

            <h3 className="devConsole__sectionTitle">

                Feedback by category

            </h3>

            <StatGrid>

                {Object.entries(beta.feedback?.byCategory ?? {}).map(
                    ([category, count]) => (

                        <StatCard
                            key={category}
                            label={category}
                            value={count}
                        />

                    )
                )}

                {Object.keys(beta.feedback?.byCategory ?? {}).length === 0 && (

                    <StatCard label="Categories" value="None yet" />

                )}

            </StatGrid>

            <h3 className="devConsole__sectionTitle">

                Incident severity

            </h3>

            <StatGrid>

                {Object.entries(beta.incidents?.bySeverity ?? {}).map(
                    ([severity, count]) => (

                        <StatCard
                            key={severity}
                            label={severity}
                            value={count}
                            tone={severity === "CRITICAL" && count > 0
                                ? "red"
                                : severity === "HIGH" && count > 0
                                    ? "yellow"
                                    : undefined}
                        />

                    )
                )}

                {Object.keys(beta.incidents?.bySeverity ?? {}).length === 0 && (

                    <StatCard label="Severities" value="None yet" />

                )}

            </StatGrid>

        </PanelShell>

    );

}
