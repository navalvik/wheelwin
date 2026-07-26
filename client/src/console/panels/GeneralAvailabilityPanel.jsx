import { useConsoleProjection } from "../ConsoleStreamProvider";
import PanelShell from "./shared/PanelShell";
import { StatCard, StatGrid } from "./shared/StatGrid";
import EmptyState from "./shared/EmptyState";

/**
 * R9.0A — General Availability panel (read-only projection).
 */
export default function GeneralAvailabilityPanel() {

    const server = useConsoleProjection("server");

    const ga = server?.ga;

    if (!server) {

        return (

            <PanelShell title="General Availability">

                <EmptyState title="Waiting for GA overview" />

            </PanelShell>

        );

    }

    if (!ga) {

        return (

            <PanelShell
                title="General Availability"
                subtitle="Release orchestration — observational only"
            >

                <EmptyState title="GA status unavailable" />

            </PanelShell>

        );

    }

    return (

        <PanelShell
            title="General Availability"
            subtitle="Rollout, verification, and operational state — no gameplay controls"
        >

            <StatGrid>

                <StatCard
                    label="Release Version"
                    value={ga.releaseVersion
                        ?? server.release?.version
                        ?? server.version
                        ?? "—"}
                />

                <StatCard
                    label="Lifecycle"
                    value={ga.lifecycle ?? "—"}
                />

                <StatCard
                    label="Rollout Stage"
                    value={ga.rolloutStage ?? "—"}
                    hint={ga.rolloutMode
                        ? `Mode ${ga.rolloutMode}`
                        : undefined}
                />

                <StatCard
                    label="Verification"
                    value={ga.verificationStatus ?? "—"}
                    hint={ga.verificationScore != null
                        ? `Score ${ga.verificationScore}`
                        : undefined}
                    tone={ga.verificationStatus === "PASSED"
                        || ga.verificationStatus === "PASSED_WITH_WARNINGS"
                        ? "green"
                        : ga.verificationStatus === "FAILED"
                            ? "red"
                            : "yellow"}
                />

                <StatCard
                    label="Production Status"
                    value={ga.productionStatus ?? "—"}
                />

                <StatCard
                    label="Operational Score"
                    value={ga.operationalScore ?? "—"}
                />

                <StatCard
                    label="Rollback"
                    value={ga.rollbackRecommended ? "RECOMMENDED" : "None"}
                    hint={ga.rollbackReason}
                    tone={ga.rollbackRecommended ? "red" : "green"}
                />

                <StatCard
                    label="GA Uptime (ms)"
                    value={ga.gaUptimeMs ?? 0}
                />

            </StatGrid>

        </PanelShell>

    );

}
