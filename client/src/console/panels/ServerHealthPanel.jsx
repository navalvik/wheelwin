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

    const lifecycleLabel = server.lifecycle
        ?? (server.shuttingDown ? "DRAINING" : "RUNNING");

    const lifecycleTone = lifecycleLabel === "RUNNING"
        ? "green"
        : lifecycleLabel === "DRAINING"
            ? "yellow"
            : "red";

    const readinessLabel = server.ready === false || lifecycleLabel === "DRAINING"
        ? "NOT READY"
        : health.overall === "green"
            ? "HEALTHY"
            : health.overall === "yellow"
                ? "DEGRADED"
                : "UNHEALTHY";

    return (

        <PanelShell
            title="Server Health"
            subtitle="Authoritative operational snapshot"
            actions={(
                <>
                    <StatusBadge tone={lifecycleTone}>

                        {lifecycleLabel}

                    </StatusBadge>
                    <StatusBadge tone={health.overall}>

                        {readinessLabel}

                    </StatusBadge>
                </>
            )}
        >

            <StatGrid>

                <StatCard label="Lifecycle" value={lifecycleLabel} />

                <StatCard
                    label="Profile"
                    value={server.configuration?.profile ?? "—"}
                />

                <StatCard
                    label="Environment"
                    value={server.configuration?.environment ?? "—"}
                />

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

                <StatCard
                    label="Logger Status"
                    value={server.logger?.status ?? "—"}
                />

                <StatCard
                    label="Log Level"
                    value={server.logger?.level
                        ?? server.configuration?.logging?.logLevel
                        ?? "—"}
                />

                <StatCard
                    label="Rotation"
                    value={server.logger?.rotationStatus ?? "—"}
                    hint={server.logger?.activeLogFile
                        ? `File ${server.logger.activeLogFile}`
                        : undefined}
                />

                <StatCard
                    label="Retention"
                    value={server.logger?.retention?.maxFiles != null
                        ? `${server.logger.retention.maxFiles} files`
                        : "—"}
                    hint={server.logger?.retention?.maxAgeDays != null
                        ? `${server.logger.retention.maxAgeDays}d`
                        : undefined}
                />

                <StatCard
                    label="Monitoring"
                    value={server.monitoring?.enabled === false
                        ? "OFF"
                        : (server.monitoring?.running ? "ON" : (metrics?.monitoring?.enabled ? "ON" : "—"))}
                    hint={server.monitoring?.freshnessMs != null
                        ? `Fresh ${server.monitoring.freshnessMs}ms`
                        : undefined}
                />

                <StatCard
                    label="CPU %"
                    value={metrics?.monitoring?.runtime?.cpuPercent != null
                        ? Number(metrics.monitoring.runtime.cpuPercent).toFixed(1)
                        : "—"}
                />

                <StatCard
                    label="Event Loop"
                    value={metrics?.monitoring?.runtime?.eventLoopDelayMs != null
                        ? `${Number(metrics.monitoring.runtime.eventLoopDelayMs).toFixed(2)}ms`
                        : "—"}
                />

                <StatCard
                    label="Tick Rate"
                    value={metrics?.monitoring?.simulation?.tickRateHz != null
                        ? `${Number(metrics.monitoring.simulation.tickRateHz).toFixed(1)} Hz`
                        : "—"}
                />

                <StatCard
                    label="Payments Pending"
                    value={metrics?.monitoring?.payments?.pending ?? "—"}
                />

                <StatCard
                    label="Recovery Queue"
                    value={metrics?.monitoring?.recovery?.queueSize ?? "—"}
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
