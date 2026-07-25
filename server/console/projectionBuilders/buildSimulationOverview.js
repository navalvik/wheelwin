/**
 * R6.0C — Simulation loop overview DTO.
 */
export function buildSimulationOverview({
    simulationLoop,
    physicsEngine,
    metricsService = null
}) {

    const tickMetric = metricsService?.getSnapshot?.()?.metrics?.["physics.tick"]
        ?? null;

    return Object.freeze({
        simulationLoop: Object.freeze({
            running: simulationLoop?.isRunning?.() === true,
            tickIntervalMs: simulationLoop?.getFixedStepMs?.() ?? null,
            runningSimulations: simulationLoop?.getActiveGameCount?.() ?? 0
        }),
        physicsActiveSimulations:
            physicsEngine?.getActiveSimulationCount?.() ?? 0,
        averageUpdateDurationMs: tickMetric?.averageMs ?? null,
        lastUpdateDurationMs: tickMetric?.lastMs ?? null,
        updateSampleCount: tickMetric?.count ?? 0
    });

}
