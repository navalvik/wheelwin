/**
 * R6.0E — Derive GREEN / YELLOW / RED from live projections (client-only).
 */

export const HEALTH_TONE = Object.freeze({
    GREEN: "green",
    YELLOW: "yellow",
    RED: "red",
    UNKNOWN: "unknown"
});

function toneFromBoolean(ok, warn = false) {

    if (ok === true && !warn) {

        return HEALTH_TONE.GREEN;

    }

    if (warn) {

        return HEALTH_TONE.YELLOW;

    }

    return HEALTH_TONE.RED;

}

/**
 * @param {{
 *   connected: boolean,
 *   server: object|null,
 *   simulation: object|null,
 *   payments: object|null,
 *   recovery: object|null,
 *   metrics: object|null,
 *   logs: array
 * }} input
 */
export function deriveSubsystemHealth({
    connected,
    server,
    simulation,
    payments,
    recovery,
    metrics,
    logs
}) {

    const healthStatus = metrics?.runtime?.healthStatus ?? null;
    const overall = healthStatus === "ok"
        ? HEALTH_TONE.GREEN
        : healthStatus === "degraded"
            ? HEALTH_TONE.YELLOW
            : connected
                ? HEALTH_TONE.YELLOW
                : HEALTH_TONE.RED;

    const socket = toneFromBoolean(connected === true);

    const loopRunning = simulation?.simulationLoop?.running === true;
    const simActive = (simulation?.simulationLoop?.runningSimulations ?? 0) > 0;
    const simulationTone = !connected
        ? HEALTH_TONE.RED
        : loopRunning
            ? HEALTH_TONE.GREEN
            : HEALTH_TONE.YELLOW;

    const pending = payments?.pendingSessions ?? 0;
    const settling = payments?.settling ?? 0;
    const paymentsTone = !connected
        ? HEALTH_TONE.RED
        : settling > 0
            ? HEALTH_TONE.YELLOW
            : pending > 8
                ? HEALTH_TONE.YELLOW
                : HEALTH_TONE.GREEN;

    const waiting = recovery?.waitingReconnect ?? 0;
    const active = recovery?.activeRecoveries ?? 0;
    const recoveryTone = !connected
        ? HEALTH_TONE.RED
        : waiting > 0
            ? HEALTH_TONE.YELLOW
            : active > 0
                ? HEALTH_TONE.YELLOW
                : HEALTH_TONE.GREEN;

    const recentErrors = (logs ?? []).filter(
        (entry) => entry?.level === "error" || entry?.level === "ERROR"
    ).length;
    const loggerTone = !connected
        ? HEALTH_TONE.RED
        : recentErrors > 0
            ? HEALTH_TONE.YELLOW
            : HEALTH_TONE.GREEN;

    const counters = metrics?.counters ?? {};
    const eventBusTone = !connected
        ? HEALTH_TONE.RED
        : Object.keys(counters).length > 0
            ? HEALTH_TONE.GREEN
            : HEALTH_TONE.YELLOW;

    return Object.freeze({
        overall,
        socket,
        simulation: simulationTone,
        payments: paymentsTone,
        recovery: recoveryTone,
        eventBus: eventBusTone,
        logger: loggerTone,
        meta: Object.freeze({
            socketCount: server?.socketCount ?? 0,
            simActive,
            pendingPayments: pending,
            settling,
            waitingReconnect: waiting,
            activeRecoveries: active,
            recentErrors
        })
    });

}
