/**
 * R8.0D — Frozen telemetry snapshot (read-only aggregates).
 */

/**
 * @param {object} [partial]
 */
export function createEmptyTelemetrySnapshot(partial = {}) {

    const gameplayPartial = partial.gameplay ?? {};

    const winnerDistribution = Object.freeze({
        ...(gameplayPartial.winnerDistribution ?? {})
    });

    return Object.freeze({
        collectedAt: partial.collectedAt ?? Date.now(),
        session: Object.freeze({
            gamesStarted: 0,
            gamesCompleted: 0,
            gamesAbandoned: 0,
            reconnectCount: 0,
            offlineRecoveryCount: 0,
            averageSessionDurationMs: 0,
            averageGameDurationMs: 0,
            averageSetupDurationMs: 0,
            averagePaymentDurationMs: 0,
            averageReadyPhaseDurationMs: 0,
            averageSpeedPhaseDurationMs: 0,
            averageBrakePhaseDurationMs: 0,
            averageResultPhaseDurationMs: 0,
            ...(partial.session ?? {})
        }),
        network: Object.freeze({
            socketReconnects: 0,
            packetLossEstimate: 0,
            connectionFailures: 0,
            averageLatencyMs: 0,
            maximumLatencyMs: 0,
            ...(partial.network ?? {})
        }),
        recovery: Object.freeze({
            recoveryAttempts: 0,
            recoverySuccessRate: 0,
            recoveryFailures: 0,
            stateRestorationCount: 0,
            ...(partial.recovery ?? {})
        }),
        payment: Object.freeze({
            paymentsInitiated: 0,
            paymentsCompleted: 0,
            paymentsFailed: 0,
            settlementSuccessRate: 0,
            settlementDurationMs: 0,
            ...(partial.payment ?? {})
        }),
        gameplay: Object.freeze({
            wheelSpins: gameplayPartial.wheelSpins ?? 0,
            winnerDistribution,
            configurationValidationFailures:
                gameplayPartial.configurationValidationFailures ?? 0,
            authoritativeSyncFailures:
                gameplayPartial.authoritativeSyncFailures ?? 0,
            desynchronizationCount:
                gameplayPartial.desynchronizationCount ?? 0,
            physicsAnomalies: gameplayPartial.physicsAnomalies ?? 0
        }),
        activeSessions: partial.activeSessions ?? 0
    });

}

/**
 * @param {object} snapshot
 */
export function freezeTelemetrySnapshot(snapshot) {

    return createEmptyTelemetrySnapshot(snapshot);

}
