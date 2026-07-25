/**
 * R7.0H — Shared reset / provider helpers for validation scenarios.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LoggingManager } from "../logging/LoggingManager.js";
import { LOG_LEVELS } from "../logging/levels.js";
import { MonitoringManager } from "../monitoring/MonitoringManager.js";
import { FailurePolicyManager } from "../failure/FailurePolicyManager.js";
import { DeploymentManager } from "../deployment/DeploymentManager.js";
import { HealthManager } from "../deployment/HealthManager.js";
import { ApplicationLifecycleManager } from "../lifecycle/ApplicationLifecycleManager.js";
import { HealthService } from "../services/HealthService.js";
import { MetricsService } from "../services/MetricsService.js";

export function delay(ms) {

    return new Promise((resolve) => setTimeout(resolve, ms));

}

export function resetAllManagers() {

    DeploymentManager.resetForTests();

    HealthManager.resetForTests();

    FailurePolicyManager.resetForTests();

    MonitoringManager.resetForTests();

    LoggingManager.resetForTests();

}

export function createTempLogDir() {

    return mkdtempSync(join(tmpdir(), "wheelwin-r70h-"));

}

/**
 * Spin up a lightweight operational stack suitable for R7.0H scenarios.
 */
export async function createValidationStack(options = {}) {

    resetAllManagers();

    const logDir = options.logDir ?? createTempLogDir();

    const logging = LoggingManager.getInstance();

    logging.initialize({
        level: LOG_LEVELS.INFO,
        directory: logDir,
        format: "json",
        enableConsole: false,
        enableFile: true,
        maxFileSizeMb: options.maxFileSizeMb ?? 1,
        maxFiles: 5,
        maxAgeDays: 7,
        environment: "test",
        profile: "development",
        version: "0.0.0-validation"
    });

    const failurePolicy = FailurePolicyManager.getInstance().initialize({
        enabled: true,
        maxAttempts: 3,
        initialDelayMs: 5,
        maxDelayMs: 50,
        circuitBreakerEnabled: true,
        circuitFailureThreshold: 3,
        circuitRecoveryTimeoutMs: 30,
        circuitSuccessThreshold: 1,
        historyLimit: 50
    });

    const metricsService = new MetricsService({ enabled: true });

    metricsService.initialize();

    const logger = {
        info() {},
        warn() {},
        error() {},
        startupLine() {}
    };

    const healthService = new HealthService({
        logger,
        productionConfig: { nodeEnv: "test" }
    });

    const state = {
        lifecycle: "STARTING",
        httpListening: false,
        socketListening: false,
        rooms: 0,
        games: 0,
        tickLatencies: [],
        httpLatencies: [],
        queueSize: 0
    };

    const lifecycle = new ApplicationLifecycleManager({
        logger,
        metricsService,
        healthService,
        loggingManager: logging,
        gracefulShutdownTimeoutMs: options.drainTimeoutMs ?? 200,
        activityProvider: () => ({
            activeGames: state.games,
            pendingPayments: 0,
            recoverySessions: 0,
            activeSimulations: state.games > 0 ? 1 : 0,
            pendingTeardowns: 0,
            resultSessions: 0,
            settlements: 0
        })
    });

    healthService.setLifecycleState("STARTING");

    const monitoring = MonitoringManager.getInstance();

    monitoring.initialize({
        enabled: true,
        prometheusEnabled: true,
        intervals: {
            runtimeMs: 40,
            gameplayMs: 40,
            simulationMs: 40,
            paymentMs: 80,
            recoveryMs: 80,
            systemMs: 40
        },
        providers: {
            roomManager: {
                getRooms: () => Array.from({ length: state.rooms }, () => ({}))
            },
            gameManager: {
                getGames: () => Array.from({ length: state.games }, () => ({}))
            },
            playerManager: {
                getDebugSnapshot: () => ({
                    players: Array.from({ length: state.rooms * 2 }, () => ({}))
                })
            },
            setupSessionLifecycle: { getActiveSessionCount: () => 0 },
            resultSessionLifecycle: { getActiveSessionCount: () => 0 },
            paymentSessionManager: { getActiveSessionCount: () => 0 },
            paymentEngine: { getActivePaymentCount: () => 0 },
            contractSettlementManager: { getActiveSettlementCount: () => 0 },
            recoveryEngine: { listActiveRecoveryGameIds: () => [] },
            simulationLoop: {
                isRunning: () => state.games > 0,
                getActiveGameCount: () => state.games,
                getFixedStepMs: () => 50
            },
            physicsEngine: {
                getActiveSimulationCount: () => (state.games > 0 ? 1 : 0)
            },
            metricsService,
            socketGateway: {
                getConnectedSocketCount: () => state.rooms * 2
            },
            consoleGateway: { getConnectedConsoleCount: () => 1 },
            loggingManager: logging,
            failurePolicy,
            deploymentHealth: {
                getSafeStatus: () => HealthManager.getInstance().getSafeStatus()
            },
            httpStats: () => ({
                requests: state.httpLatencies.length,
                errors: 0,
                totalLatencyMs: state.httpLatencies.reduce((a, b) => a + b, 0)
            }),
            lifecycleState: () => lifecycle.getState(),
            environment: () => "test",
            profile: () => "development",
            version: () => "0.0.0-validation"
        }
    });

    const deployment = DeploymentManager.getInstance();

    deployment.initialize({
        deployment: {
            profile: "development",
            healthEnabled: true,
            readinessEnabled: true,
            livenessEnabled: true,
            startupEnabled: true,
            probeRefreshIntervalMs: 40
        },
        providers: {
            lifecycleState: () => lifecycle.getState(),
            lifecycleInitialized: () => true,
            configurationLoaded: () => true,
            loggingActive: () => logging.isInitialized(),
            monitoringInitialized: () => monitoring != null,
            monitoringActive: () => monitoring.isRunning(),
            monitoringRequired: () => true,
            failurePolicyInitialized: () => failurePolicy != null,
            httpListening: () => state.httpListening,
            socketListening: () => state.socketListening,
            activeGames: () => state.games,
            activeRooms: () => state.rooms,
            eventLoopDelayMs: () => {
                const snap = monitoring.getSnapshot();
                return snap?.runtime?.eventLoopDelayMs ?? 0.5;
            },
            memory: () => process.memoryUsage()
        }
    });

    const healthManager = deployment.getHealthManager();

    healthService.setHealthManager(healthManager);

    healthService.setLoggerStatus(logging.getSafeStatus());

    healthService.setMonitoringStatus(monitoring.getHealthStatus());

    healthService.setFailurePolicyStatus(failurePolicy.getSafeStatus());

    healthService.setSafeConfiguration({
        profile: "development",
        environment: "test",
        version: "0.0.0-validation"
    });

    return {
        state,
        logging,
        failurePolicy,
        monitoring,
        deployment,
        healthManager,
        healthService,
        lifecycle,
        metricsService,
        logDir,
        markReady() {
            state.httpListening = true;
            state.socketListening = true;
            lifecycle.markRunning();
            healthService.setLifecycleState("RUNNING");
            healthManager.refresh();
        },
        async shutdown() {
            try {
                if (lifecycle.getState() === "RUNNING") {
                    await lifecycle.beginDrain({ reason: "validation_teardown" });
                }
            } catch {
                // ignore
            }
            monitoring.shutdown();
            failurePolicy.shutdown();
            deployment.shutdown();
            logging.flushSync();
            logging.shutdown();
            metricsService.shutdown?.();
            resetAllManagers();
        }
    };

}

export function average(values) {

    if (!values.length) {

        return 0;

    }

    return values.reduce((a, b) => a + b, 0) / values.length;

}

export function maxOf(values) {

    if (!values.length) {

        return 0;

    }

    return Math.max(...values);

}

export function containsSensitive(text) {

    return /password|mnemonic|private[_-]?key|jwt|authorization:\s*bearer|secret/i
        .test(String(text ?? ""));

}
