/**
 * R7.0B — ApplicationLifecycleManager unit tests.
 */

import { ApplicationLifecycleManager } from "../lifecycle/ApplicationLifecycleManager.js";
import { APPLICATION_LIFECYCLE } from "../lifecycle/ApplicationLifecycleStates.js";
import { LoggerService } from "../services/LoggerService.js";
import { MetricsService } from "../services/MetricsService.js";
import { HealthService } from "../services/HealthService.js";
import { loadProductionConfig } from "../config/production.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

const logger = new LoggerService({ logLevel: "error" });

logger.initialize();

const metrics = new MetricsService({ enabled: true });

metrics.initialize();

const health = new HealthService({
    logger,
    productionConfig: loadProductionConfig({ NODE_ENV: "development" })
});

health.registerComponents({ logger: true });

let activity = {
    setupSessions: 0,
    activeGames: 0,
    paymentSessions: 0,
    pendingPayments: 0,
    settlements: 0,
    pendingTeardowns: 0,
    activeSimulations: 0,
    recoverySessions: 0,
    resultSessions: 0
};

const lifecycle = new ApplicationLifecycleManager({
    logger,
    metricsService: metrics,
    healthService: health,
    gracefulShutdownTimeoutMs: 500,
    pollIntervalMs: 50,
    activityProvider: () => ({ ...activity })
});

assert(
    lifecycle.getState() === APPLICATION_LIFECYCLE.STARTING,
    "initial state should be STARTING"
);

assert(
    lifecycle.isAcceptingNewWork() === false,
    "STARTING must not accept new work"
);

lifecycle.markRunning();

assert(
    lifecycle.getState() === APPLICATION_LIFECYCLE.RUNNING,
    "markRunning should transition to RUNNING"
);

assert(
    lifecycle.isAcceptingNewWork() === true,
    "RUNNING must accept new work"
);

assert(
    health.getHealthSnapshot().ready === true,
    "health ready while RUNNING"
);

assert(
    health.getHealthSnapshot().status === "ok",
    "health status ok while RUNNING"
);

activity.activeGames = 1;

const drainPromise = lifecycle.beginDrain({ reason: "test_drain" });

assert(
    lifecycle.getState() === APPLICATION_LIFECYCLE.DRAINING,
    "beginDrain should enter DRAINING"
);

assert(
    lifecycle.isAcceptingNewWork() === false,
    "DRAINING must reject new work"
);

const healthDraining = health.getHealthSnapshot();

assert(
    healthDraining.ready === false,
    "health Not Ready while DRAINING"
);

assert(
    healthDraining.status === "not_ready",
    "health status not_ready while DRAINING"
);

assert(
    healthDraining.lifecycle === APPLICATION_LIFECYCLE.DRAINING,
    "health mirrors DRAINING lifecycle"
);

// Clear in-flight work so drain can complete gracefully.
setTimeout(() => {

    activity.activeGames = 0;

}, 80);

const drainResult = await drainPromise;

assert(drainResult.forced === false, "drain should complete without force");

assert(
    metrics.getCounter("shutdownStarted") === 1,
    "shutdownStarted metric should increment"
);

lifecycle.markStopped({ forced: false });

assert(
    lifecycle.getState() === APPLICATION_LIFECYCLE.STOPPED,
    "markStopped should reach STOPPED"
);

assert(
    Number.isFinite(metrics.getSnapshot().metrics.shutdownDuration?.lastMs),
    "shutdownDuration timing should be recorded"
);

// Forced shutdown path
activity.activeGames = 2;

const forcedLifecycle = new ApplicationLifecycleManager({
    logger,
    metricsService: metrics,
    healthService: health,
    gracefulShutdownTimeoutMs: 120,
    pollIntervalMs: 40,
    activityProvider: () => ({ ...activity })
});

forcedLifecycle.markRunning();

const forcedResult = await forcedLifecycle.beginDrain({ reason: "force_test" });

assert(forcedResult.forced === true, "timeout should force shutdown");

forcedLifecycle.markStopped({ forced: true });

assert(
    metrics.getCounter("forcedShutdown") >= 1,
    "forcedShutdown metric should increment"
);

console.log("applicationLifecycle.test.js: OK");
