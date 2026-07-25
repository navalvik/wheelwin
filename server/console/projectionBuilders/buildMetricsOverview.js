/**
 * R6.0C — High-level operational metrics only.
 */
export function buildMetricsOverview({
    metricsService,
    healthService = null,
    roomManager,
    gameManager,
    playerManager,
    socketGateway,
    simulationLoop
}) {

    const metricsSnapshot = metricsService?.getSnapshot?.() ?? {
        enabled: false,
        metrics: {},
        counters: {}
    };

    const health = healthService?.getHealthSnapshot?.() ?? null;

    return Object.freeze({
        enabled: metricsSnapshot.enabled === true,
        counters: Object.freeze({ ...(metricsSnapshot.counters ?? {}) }),
        timings: Object.freeze(
            Object.fromEntries(
                Object.entries(metricsSnapshot.metrics ?? {}).map(
                    ([name, record]) => [
                        name,
                        Object.freeze({
                            count: record.count,
                            averageMs: record.averageMs,
                            lastMs: record.lastMs,
                            minMs: record.minMs,
                            maxMs: record.maxMs
                        })
                    ]
                )
            )
        ),
        runtime: Object.freeze({
            activeRooms: roomManager?.getActiveRoomCount?.()
                ?? roomManager?.getRooms?.()?.length
                ?? 0,
            activeGames: gameManager?.getGames?.()?.length ?? 0,
            activePlayers:
                playerManager?.getDebugSnapshot?.()?.players?.length ?? 0,
            activeSockets: socketGateway?.getConnectedSocketCount?.() ?? 0,
            activeSimulations: simulationLoop?.getActiveGameCount?.() ?? 0,
            healthStatus: health?.status ?? null,
            uptimeMs: health?.uptimeMs ?? null
        })
    });

}
