import { useConsoleProjection } from "../ConsoleStreamProvider";
import { formatDurationMs } from "../formatters";
import PanelShell from "./shared/PanelShell";
import { StatCard, StatGrid } from "./shared/StatGrid";
import { StatusBadge } from "./shared/StatusDot";
import EmptyState from "./shared/EmptyState";

export default function SimulationPanel() {

    const simulation = useConsoleProjection("simulation");

    if (!simulation) {

        return (

            <PanelShell title="Simulation">

                <EmptyState title="Waiting for simulation overview" />

            </PanelShell>

        );

    }

    const loop = simulation.simulationLoop ?? {};

    return (

        <PanelShell
            title="Simulation"
            actions={(
                <StatusBadge tone={loop.running ? "green" : "yellow"}>

                    {loop.running ? "LOOP RUNNING" : "LOOP IDLE"}

                </StatusBadge>
            )}
        >

            <StatGrid>

                <StatCard
                    label="SimulationLoop"
                    value={loop.running ? "Running" : "Stopped"}
                />

                <StatCard
                    label="Tick interval"
                    value={
                        loop.tickIntervalMs != null
                            ? `${loop.tickIntervalMs} ms`
                            : "—"
                    }
                />

                <StatCard
                    label="Current update"
                    value={formatDurationMs(simulation.lastUpdateDurationMs)}
                />

                <StatCard
                    label="Average update"
                    value={formatDurationMs(simulation.averageUpdateDurationMs)}
                    hint={
                        simulation.updateSampleCount
                            ? `${simulation.updateSampleCount} samples`
                            : null
                    }
                />

                <StatCard
                    label="Active simulations"
                    value={loop.runningSimulations ?? 0}
                />

                <StatCard
                    label="Physics active"
                    value={simulation.physicsActiveSimulations ?? 0}
                />

            </StatGrid>

        </PanelShell>

    );

}
