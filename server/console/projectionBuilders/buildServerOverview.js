/**
 * R6.0C — Server overview DTO (pure assembler).
 */
export function buildServerOverview({
    version,
    startedAt,
    healthService = null,
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
    const healthUptime = healthService?.getHealthSnapshot?.()?.uptimeMs;

    return Object.freeze({
        version: version ?? "unknown",
        uptimeMs: Number.isFinite(healthUptime)
            ? healthUptime
            : (startedAt != null
                ? Math.max(0, Date.now() - startedAt)
                : 0),
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
        })
    });

}
