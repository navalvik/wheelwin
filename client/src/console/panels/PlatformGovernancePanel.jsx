import { useConsoleProjection } from "../ConsoleStreamProvider";
import PanelShell from "./shared/PanelShell";
import { StatCard, StatGrid } from "./shared/StatGrid";
import EmptyState from "./shared/EmptyState";

/**
 * R9.0C — Platform Governance panel (read-only).
 */
export default function PlatformGovernancePanel() {

    const server = useConsoleProjection("server");

    const gov = server?.governance;

    if (!server) {

        return (

            <PanelShell title="Platform Governance">

                <EmptyState title="Waiting for governance overview" />

            </PanelShell>

        );

    }

    if (!gov) {

        return (

            <PanelShell
                title="Platform Governance"
                subtitle="Long-term audit & compliance — observational only"
            >

                <EmptyState title="Governance status unavailable" />

            </PanelShell>

        );

    }

    return (

        <PanelShell
            title="Platform Governance"
            subtitle="Audit, compliance, risk, and evidence — no runtime controls"
        >

            <StatGrid>

                <StatCard
                    label="Governance State"
                    value={gov.lifecycle ?? "—"}
                />

                <StatCard
                    label="Audit Cycle"
                    value={gov.cycle ?? 0}
                />

                <StatCard
                    label="Governance Score"
                    value={gov.governanceScore ?? "—"}
                />

                <StatCard
                    label="Last Audit Score"
                    value={gov.auditScore ?? "—"}
                />

                <StatCard
                    label="Compliance Score"
                    value={gov.complianceScore ?? "—"}
                    hint={gov.complianceFailed != null
                        ? `Failed ${gov.complianceFailed}`
                        : undefined}
                    tone={(gov.complianceFailed ?? 0) > 0
                        ? "red"
                        : "green"}
                />

                <StatCard
                    label="Risk Score"
                    value={gov.riskScore ?? "—"}
                    hint={gov.riskCritical != null
                        ? `Critical ${gov.riskCritical}`
                        : undefined}
                    tone={(gov.riskCritical ?? 0) > 0
                        ? "red"
                        : undefined}
                />

                <StatCard
                    label="Platform Review"
                    value={gov.reviewScore ?? "—"}
                />

                <StatCard
                    label="Decision"
                    value={gov.decisionStatus ?? "—"}
                />

                <StatCard
                    label="Policies"
                    value={gov.policyStatus?.approved ?? "—"}
                    hint={gov.policyStatus?.total != null
                        ? `Total ${gov.policyStatus.total}`
                        : undefined}
                />

                <StatCard
                    label="Evidence Archive"
                    value={gov.archiveCount ?? 0}
                    hint={gov.evidenceHash
                        ? `Hash ${gov.evidenceHash}`
                        : undefined}
                />

                <StatCard
                    label="Audit Trail"
                    value={gov.trailCount ?? 0}
                />

            </StatGrid>

        </PanelShell>

    );

}
