/**
 * R6.0C / R7.0B — Server overview DTO (pure assembler).
 */
export function buildServerOverview({
    version,
    startedAt,
    healthService = null,
    lifecycleManager = null,
    roomManager,
    gameManager,
    playerManager,
    setupSessionLifecycle,
    recoveryEngine,
    simulationLoop,
    socketGateway,
    resultSessionLifecycle = null
}) {

    const rooms = roomManager?.getRooms?.() ?? [];
    const games = gameManager?.getGames?.() ?? [];
    const players = playerManager?.getDebugSnapshot?.()?.players ?? [];
    const setup = setupSessionLifecycle?.getDebugSnapshot?.() ?? { activeCount: 0 };
    const recoveryIds = recoveryEngine?.listActiveRecoveryGameIds?.() ?? [];
    const memory = process.memoryUsage();
    const health = healthService?.getHealthSnapshot?.() ?? null;
    const healthUptime = health?.uptimeMs;
    const lifecycleSnapshot = lifecycleManager?.getSnapshot?.() ?? null;

    const lifecycle = lifecycleSnapshot?.state
        ?? health?.lifecycle
        ?? null;

    return Object.freeze({
        version: version ?? "unknown",
        uptimeMs: Number.isFinite(healthUptime)
            ? healthUptime
            : (startedAt != null
                ? Math.max(0, Date.now() - startedAt)
                : 0),
        lifecycle,
        ready: lifecycleSnapshot?.ready
            ?? health?.ready
            ?? (lifecycle === "RUNNING"),
        shuttingDown: lifecycleSnapshot?.shuttingDown
            ?? health?.shuttingDown
            ?? false,
        forcedShutdown: lifecycleSnapshot?.forcedShutdown ?? false,
        shutdownDurationMs: lifecycleSnapshot?.shutdownDurationMs ?? null,
        drainActivity: lifecycleSnapshot?.activity
            ? Object.freeze({ ...lifecycleSnapshot.activity })
            : null,
        activeRooms: rooms.length,
        activeGames: games.length,
        activePlayers: players.length,
        activeSetupSessions: setup.activeCount ?? 0,
        activeRecoverySessions: recoveryIds.length,
        activeResultSessions:
            resultSessionLifecycle?.getActiveSessionCount?.() ?? 0,
        activeSimulations: simulationLoop?.getActiveGameCount?.() ?? 0,
        socketCount: socketGateway?.getConnectedSocketCount?.() ?? 0,
        memory: Object.freeze({
            rss: memory.rss,
            heapTotal: memory.heapTotal,
            heapUsed: memory.heapUsed,
            external: memory.external,
            arrayBuffers: memory.arrayBuffers ?? 0
        }),
        configuration: health?.configuration
            ? Object.freeze({ ...health.configuration })
            : null
    });

}
