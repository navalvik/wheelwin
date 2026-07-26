/**
 * R9.0B — KPI result snapshot.
 */

/**
 * @param {object} [partial]
 */
export function createKPIResult(partial = {}) {

    return Object.freeze({
        collectedAt: partial.collectedAt ?? Date.now(),
        serviceUptimeMs: Number(partial.serviceUptimeMs) || 0,
        availability: Number(partial.availability) || 0,
        averageLatencyMs: Number(partial.averageLatencyMs) || 0,
        peakLatencyMs: Number(partial.peakLatencyMs) || 0,
        errorRate: Number(partial.errorRate) || 0,
        crashRate: Number(partial.crashRate) || 0,
        recoverySuccessRate: Number(partial.recoverySuccessRate) || 0,
        paymentSuccessRate: Number(partial.paymentSuccessRate) || 0,
        settlementSuccessRate: Number(partial.settlementSuccessRate) || 0,
        reconnectRate: Number(partial.reconnectRate) || 0,
        cpuUtilization: Number(partial.cpuUtilization) || 0,
        memoryUtilization: Number(partial.memoryUtilization) || 0,
        eventLoopLatencyMs: Number(partial.eventLoopLatencyMs) || 0,
        averageGameDurationMs: Number(partial.averageGameDurationMs) || 0,
        averageSessionDurationMs: Number(partial.averageSessionDurationMs) || 0,
        dailyActiveSessions: Number(partial.dailyActiveSessions) || 0
    });

}
