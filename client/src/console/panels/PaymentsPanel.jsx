import { useConsoleProjection } from "../ConsoleStreamProvider";
import PanelShell from "./shared/PanelShell";
import { StatCard, StatGrid } from "./shared/StatGrid";
import EmptyState from "./shared/EmptyState";

export default function PaymentsPanel() {

    const payments = useConsoleProjection("payments");

    if (!payments) {

        return (

            <PanelShell title="Payments">

                <EmptyState title="Waiting for payments overview" />

            </PanelShell>

        );

    }

    return (

        <PanelShell
            title="Payments"
            subtitle="Statistics only — no organizer or wallet data"
        >

            <StatGrid>

                <StatCard
                    label="Pending"
                    value={payments.pendingSessions}
                    tone="yellow"
                />

                <StatCard
                    label="Confirmed"
                    value={payments.confirmed}
                    tone="green"
                />

                <StatCard
                    label="Settling"
                    value={payments.settling}
                    tone="yellow"
                />

                <StatCard
                    label="Completed"
                    value={payments.completed}
                    tone="green"
                />

            </StatGrid>

            <h3 className="devConsole__sectionTitle">

                Session counts

            </h3>

            <StatGrid>

                <StatCard
                    label="Active sessions"
                    value={payments.sessions?.length ?? 0}
                />

                <StatCard
                    label="Contracts"
                    value={payments.contracts?.length ?? 0}
                />

                <StatCard
                    label="Settlements tracked"
                    value={payments.settlements?.length ?? 0}
                />

            </StatGrid>

        </PanelShell>

    );

}
