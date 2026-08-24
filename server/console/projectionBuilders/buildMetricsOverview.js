/**
 * R6.0C / R7.0E — High-level operational metrics only.
 * R17.9T.8-completion — exposes MonitoringManager registry gauges (including
 * the R17.9T.8 room-pool gauges) to the Developer Console Metrics panel.
 * Read-only passthrough; no calculations changed.
 */
export function buildMetricsOverview({
    metricsService,
    healthService = null,
    monitoringManager = null,
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

    const monitoring = health?.runtime?.monitoring
        ?? health?.monitoring
        ?? null;

    // R17.9T.8-completion — registry gauges from the monitoring snapshot.
    const monitoringSnapshot = monitoringManager?.getSnapshot?.() ?? null;

    const gauges = {
        ...(monitoringSnapshot?.gauges ?? {})
    };

    const gaugeOrNull = (name) =>
        Number.isFinite(gauges[name]) ? gauges[name] : null;

    const roomPool = Object.freeze({
        max: gaugeOrNull("gameplay.room_pool_max"),
        utilization: gaugeOrNull("gameplay.room_pool_utilization"),
        nearCapacity: gaugeOrNull("gameplay.room_pool_near_capacity"),
        createdPerMin: gaugeOrNull("gameplay.rooms_created_per_min"),
        limitRejectionsPerMin:
            gaugeOrNull("gameplay.rooms_creation_limit_rejected_per_min"),
        createdTotal: gaugeOrNull("gameplay.rooms_created_total"),
        limitTotal: gaugeOrNull("gameplay.rooms_creation_limit_total")
    });

    return Object.freeze({
        enabled: metricsSnapshot.enabled === true
            || monitoring?.enabled === true,
        gauges: Object.freeze(gauges),
        roomPool,
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
            ready: health?.ready ?? null,
            lifecycle: health?.lifecycle ?? null,
            uptimeMs: health?.uptimeMs ?? null
        }),
        monitoring: monitoring
            ? Object.freeze({ ...monitoring })
            : null
    });

}
