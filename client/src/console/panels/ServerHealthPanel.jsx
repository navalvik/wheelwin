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

                <StatCard
                    label="Failure Policy"
                    value={server.failurePolicy?.enabled === false
                        ? "OFF"
                        : (server.failurePolicy?.enabled ? "ON" : "—")}
                    hint={server.failurePolicy?.retryQueueSize != null
                        ? `Queue ${server.failurePolicy.retryQueueSize}`
                        : undefined}
                />

                <StatCard
                    label="Retry Queue"
                    value={server.failurePolicy?.retryQueueSize ?? "—"}
                />

                <StatCard
                    label="Circuit Breakers"
                    value={Array.isArray(server.failurePolicy?.circuitBreakers)
                        ? server.failurePolicy.circuitBreakers
                            .filter((c) => c.state === "OPEN").length
                        : "—"}
                    hint={Array.isArray(server.failurePolicy?.circuitBreakers)
                        ? `${server.failurePolicy.circuitBreakers.length} total`
                        : undefined}
                />

                <StatCard
                    label="Recoverable Failures"
                    value={server.failurePolicy?.recoverableFailures ?? "—"}
                />

                <StatCard
                    label="Fatal Failures"
                    value={server.failurePolicy?.fatalFailures ?? "—"}
                />

                <StatCard
                    label="Escalations"
                    value={server.failurePolicy?.escalationCount ?? "—"}
                />

                <StatCard
                    label="Retry Statistics"
                    value={server.failurePolicy?.retryCount ?? "—"}
                    hint={
                        server.failurePolicy?.retrySuccess != null
                            ? `ok ${server.failurePolicy.retrySuccess} / fail ${server.failurePolicy.retryFailure ?? 0}`
                            : undefined
                    }
                />

                <StatCard
                    label="Circuit Recovery"
                    value={
                        Array.isArray(server.failurePolicy?.circuitBreakers)
                            ? server.failurePolicy.circuitBreakers
                                .reduce((sum, c) => sum + (c.recoveryCount ?? 0), 0)
                            : "—"
                    }
                />

                <StatCard
                    label="Startup"
                    value={server.probes?.startup?.ok === true
                        ? "OK"
                        : server.probes?.startup?.ok === false
                            ? "PENDING"
                            : (server.deployment?.startup === true ? "OK" : "—")}
                />

                <StatCard
                    label="Liveness"
                    value={server.probes?.liveness?.ok === true
                        || server.deployment?.live === true
                        ? "LIVE"
                        : server.probes?.liveness?.ok === false
                            || server.deployment?.live === false
                            ? "DEAD"
                            : "—"}
                />

                <StatCard
                    label="Readiness"
                    value={server.probes?.readiness?.ok === true
                        || server.deployment?.ready === true
                        ? "READY"
                        : server.ready === false
                            ? "NOT READY"
                            : "—"}
                />

                <StatCard
                    label="Deployment Profile"
                    value={server.deployment?.profile
                        ?? server.configuration?.deployment?.profile
                        ?? server.configuration?.profile
                        ?? "—"}
                />

                <StatCard
                    label="HTTP Status"
                    value={server.deployment?.http === true
                        || server.probes?.health?.details?.components?.http === true
                        ? "LISTENING"
                        : server.deployment?.http === false
                            ? "DOWN"
                            : "—"}
                />

                <StatCard
                    label="Socket Status"
                    value={server.deployment?.socket === true
                        || server.probes?.health?.details?.components?.socket === true
                        ? "UP"
                        : server.deployment?.socket === false
                            ? "DOWN"
                            : "—"}
                />

                <StatCard
                    label="Overall Health"
                    value={server.deployment?.overall
                        ?? server.probes?.health?.overall
                        ?? server.status
                        ?? "—"}
                />

                <StatCard
                    label="Current Version"
                    value={server.release?.version
                        ?? server.version
                        ?? "—"}
                />

                <StatCard
                    label="Release Channel"
                    value={server.release?.channel
                        ?? server.configuration?.release?.channel
                        ?? "—"}
                />

                <StatCard
                    label="Build Timestamp"
                    value={server.release?.builtAt
                        ? String(server.release.builtAt).slice(0, 19)
                        : "—"}
                />

                <StatCard
                    label="Commit"
                    value={server.release?.commit
                        ? String(server.release.commit).slice(0, 12)
                        : "—"}
                />

                <StatCard
                    label="Build Fingerprint"
                    value={server.release?.fingerprint
                        && server.release.fingerprint !== "unbuilt"
                        ? String(server.release.fingerprint).slice(0, 12)
                        : "—"}
                    hint={server.release?.fingerprint
                        && server.release.fingerprint !== "unbuilt"
                        ? String(server.release.fingerprint).slice(0, 24)
                        : undefined}
                />

                <StatCard
                    label="Release Status"
                    value={server.release?.status ?? "—"}
                />

                <StatCard
                    label="Certification Status"
                    value={server.certification?.status ?? "—"}
                    hint={server.certification?.betaReady
                        ? "Beta ready"
                        : undefined}
                />

                <StatCard
                    label="Certification Time"
                    value={server.certification?.certifiedAt
                        ? String(server.certification.certifiedAt).slice(0, 19)
                        : "—"}
                />

                <StatCard
                    label="Cert Fingerprint"
                    value={server.certification?.fingerprint
                        && server.certification.fingerprint !== "unknown"
                        ? String(server.certification.fingerprint).slice(0, 12)
                        : (server.release?.fingerprint
                            && server.release.fingerprint !== "unbuilt"
                            ? String(server.release.fingerprint).slice(0, 12)
                            : "—")}
                />

                <StatCard
                    label="Cert Warnings"
                    value={server.certification?.warnings ?? "—"}
                    hint={server.certification?.failures != null
                        ? `Failures ${server.certification.failures}`
                        : undefined}
                />

                <StatCard
                    label="Closed Beta"
                    value={server.closedBeta?.lifecycle ?? "—"}
                    hint={server.closedBeta?.readiness
                        ? `Readiness ${server.closedBeta.readiness}`
                        : undefined}
                />

                <StatCard
                    label="Beta Participants"
                    value={server.closedBeta?.participantCount ?? "—"}
                />

                <StatCard
                    label="Beta Readiness"
                    value={server.closedBeta?.readinessScore != null
                        ? `${server.closedBeta.readinessScore}`
                        : "—"}
                    hint={server.closedBeta?.readiness}
                />

                <StatCard
                    label="Launch Decision"
                    value={server.launch?.decision ?? "—"}
                    hint={server.launch?.lifecycle}
                />

                <StatCard
                    label="Launch Score"
                    value={server.launch?.readinessScore ?? "—"}
                />

                <StatCard
                    label="Launch Blockers"
                    value={server.launch?.blockerSummary?.critical != null
                        ? server.launch.blockerSummary.critical
                        : "—"}
                    hint={server.launch?.blockerSummary?.high != null
                        ? `High ${server.launch.blockerSummary.high}`
                        : undefined}
                />

                <StatCard
                    label="GA Lifecycle"
                    value={server.ga?.lifecycle ?? "—"}
                />

                <StatCard
                    label="GA Verification"
                    value={server.ga?.verificationStatus ?? "—"}
                />

                <StatCard
                    label="GA Score"
                    value={server.ga?.operationalScore ?? "—"}
                />

                <StatCard
                    label="Ops Lifecycle"
                    value={server.operations?.lifecycle ?? "—"}
                />

                <StatCard
                    label="Ops Score"
                    value={server.operations?.operationalScore ?? "—"}
                />

                <StatCard
                    label="Ops Version"
                    value={server.operations?.currentVersion ?? "—"}
                />

                <StatCard
                    label="Governance State"
                    value={server.governance?.lifecycle ?? "—"}
                />

                <StatCard
                    label="Governance Score"
                    value={server.governance?.governanceScore ?? "—"}
                />

                <StatCard
                    label="Compliance Score"
                    value={server.governance?.complianceScore ?? "—"}
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
