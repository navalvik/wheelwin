import { useMemo } from "react";

import {
    useConsoleConnectionStatus,
    useConsoleProjection
} from "../ConsoleStreamProvider";
import { deriveSubsystemHealth } from "../healthStatus";
import {
    formatBytes,
    formatUptime
} from "../formatters";
import PanelShell from "./shared/PanelShell";
import { StatCard, StatGrid } from "./shared/StatGrid";
import { StatusBadge } from "./shared/StatusDot";
import EmptyState from "./shared/EmptyState";

const SUBSYSTEMS = [
    { key: "socket", label: "Socket.IO" },
    { key: "simulation", label: "Simulation" },
    { key: "payments", label: "Payments" },
    { key: "recovery", label: "Recovery" },
    { key: "eventBus", label: "EventBus" },
    { key: "logger", label: "Logger" }
];

export default function ServerHealthPanel() {

    const server = useConsoleProjection("server");
    const simulation = useConsoleProjection("simulation");
    const payments = useConsoleProjection("payments");
    const recovery = useConsoleProjection("recovery");
    const metrics = useConsoleProjection("metrics");
    const logs = useConsoleProjection("logs");
    const { connected } = useConsoleConnectionStatus();

    const health = useMemo(
        () => deriveSubsystemHealth({
            connected,
            server,
            simulation,
            payments,
            recovery,
            metrics,
            logs
        }),
        [connected, server, simulation, payments, recovery, metrics, logs]
    );

    if (!server) {

        return (

            <PanelShell title="Server Health">

                <EmptyState
                    title="Waiting for server overview"
                    detail="Live CONSOLE_SERVER projection has not arrived yet."
                />

            </PanelShell>

        );

    }

    return (

        <PanelShell
            title="Server Health"
            subtitle="Authoritative operational snapshot"
            actions={(
                <StatusBadge tone={health.overall}>

                    {health.overall === "green"
                        ? "HEALTHY"
                        : health.overall === "yellow"
                            ? "DEGRADED"
                            : "UNHEALTHY"}

                </StatusBadge>
            )}
        >

            <StatGrid>

                <StatCard label="Version" value={server.version} />

                <StatCard
                    label="Uptime"
                    value={formatUptime(server.uptimeMs)}
                />

                <StatCard
                    label="Memory (heap)"
                    value={formatBytes(server.memory?.heapUsed)}
                    hint={`RSS ${formatBytes(server.memory?.rss)}`}
                />

                <StatCard label="Sockets" value={server.socketCount} />

                <StatCard label="Rooms" value={server.activeRooms} />

                <StatCard label="Games" value={server.activeGames} />

                <StatCard label="Players" value={server.activePlayers} />

                <StatCard
                    label="Setup Sessions"
                    value={server.activeSetupSessions}
                />

                <StatCard
                    label="Recovery Sessions"
                    value={server.activeRecoverySessions}
                />

                <StatCard
                    label="Simulation Loop"
                    value={server.activeSimulations}
                    hint={
                        simulation?.simulationLoop?.running
                            ? "Running"
                            : "Idle"
                    }
                />

            </StatGrid>

            <h3 className="devConsole__sectionTitle">

                Subsystem status

            </h3>

            <div className="devConsole__subsystemGrid">

                {SUBSYSTEMS.map((subsystem) => (

                    <div
                        key={subsystem.key}
                        className="devConsole__subsystemCard"
                    >

                        <StatusBadge tone={health[subsystem.key]}>

                            {subsystem.label}

                        </StatusBadge>

                        <span className="devConsole__subsystemTone">

                            {String(health[subsystem.key]).toUpperCase()}

                        </span>

                    </div>

                ))}

            </div>

        </PanelShell>

    );

}
