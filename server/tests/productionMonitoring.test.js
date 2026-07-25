/**
 * R7.0E — Monitoring & metrics subsystem tests.
 */

import assert from "node:assert/strict";

import { MonitoringManager } from "../monitoring/MonitoringManager.js";
import { MetricsRegistry } from "../monitoring/MetricsRegistry.js";
import { PrometheusExporter } from "../monitoring/exporters/PrometheusExporter.js";
import { MetricsSnapshot } from "../monitoring/MetricsSnapshot.js";
import { MetricsService } from "../services/MetricsService.js";

function delay(ms) {

    return new Promise((resolve) => setTimeout(resolve, ms));

}

function reset() {

    MonitoringManager.resetForTests();

}

function createProviders(overrides = {}) {

    const metricsService = new MetricsService({ enabled: true });

    metricsService.initialize();

    metricsService.increment("games.started", 2);

    metricsService.increment("games.completed", 1);

    metricsService.increment("payments.completed", 3);

    metricsService.increment("payments.failed", 1);

    metricsService.increment("reconnects", 4);

    metricsService.record("physics.tick", 2.5);

    metricsService.record("physics.tick", 3.5);

    metricsService.record("game.duration", 1000);

    metricsService.record("payment.process", 200);

    metricsService.record("recovery.build", 15);

    return {
        roomManager: { getRooms: () => [{}, {}] },
        gameManager: { getGames: () => [{}] },
        playerManager: { getDebugSnapshot: () => ({ players: [{}, {}, {}] }) },
        setupSessionLifecycle: { getActiveSessionCount: () => 1 },
        resultSessionLifecycle: { getActiveSessionCount: () => 0 },
        paymentSessionManager: { getActiveSessionCount: () => 2 },
        paymentEngine: { getActivePaymentCount: () => 1 },
        contractSettlementManager: { getActiveSettlementCount: () => 0 },
        recoveryEngine: { listActiveRecoveryGameIds: () => ["g1"] },
        simulationLoop: {
            isRunning: () => true,
            getActiveGameCount: () => 1,
            getFixedStepMs: () => 50
        },
        physicsEngine: { getActiveSimulationCount: () => 1 },
        metricsService,
        socketGateway: { getConnectedSocketCount: () => 5 },
        consoleGateway: { getConnectedConsoleCount: () => 1 },
        loggingManager: {
            getSafeStatus: () => ({ stats: { written: 10 } }),
            getRecentRecords: () => [{}, {}]
        },
        httpStats: () => ({ requests: 20, errors: 1, totalLatencyMs: 40 }),
        lifecycleState: () => "RUNNING",
        environment: () => "development",
        profile: () => "development",
        version: () => "0.0.0-test",
        ...overrides
    };

}

// --- Registry ---
{
    const registry = new MetricsRegistry();

    registry.setGauge("a", 1.5);

    registry.incrementCounter("b", 2);

    assert.equal(registry.getGauge("a"), 1.5);

    assert.equal(registry.getCounter("b"), 2);

    console.log("  metrics registry: OK");
}

// --- Collectors + scheduling ---
{
    reset();

    const manager = MonitoringManager.getInstance();

    manager.initialize({
        enabled: true,
        prometheusEnabled: true,
        intervals: {
            runtimeMs: 50,
            gameplayMs: 50,
            simulationMs: 50,
            paymentMs: 50,
            recoveryMs: 50,
            systemMs: 50
        },
        providers: createProviders()
    });

    manager.collectNow();

    const snapshot = manager.getSnapshot();

    assert.equal(snapshot.enabled, true);

    assert.equal(snapshot.gameplay.activeRooms, 2);

    assert.equal(snapshot.gameplay.activeGames, 1);

    assert.equal(snapshot.gameplay.activePlayers, 3);

    assert.equal(snapshot.payments.completed, 3);

    assert.equal(snapshot.recovery.queueSize, 1);

    assert.equal(snapshot.runtime.heapUsedBytes > 0, true);

    assert.equal(Number.isFinite(snapshot.simulation.tickRateHz), true);

    assert.equal(manager.isRunning(), true);

    const health = manager.getHealthStatus();

    assert.equal(health.enabled, true);

    assert.equal(health.collectorCount >= 5, true);

    assert.equal(Number.isFinite(health.freshnessMs), true);

    await delay(80);

    const after = manager.getSnapshot();

    assert.equal(after.collectedAt >= snapshot.collectedAt, true);

    console.log("  collectors + scheduling + freshness: OK");
}

// --- Prometheus export ---
{
    const snapshot = MonitoringManager.getInstance().getSnapshot();

    const text = new PrometheusExporter().export(snapshot);

    assert.match(text, /wheelwin_runtime_uptime_ms/);

    assert.match(text, /wheelwin_gameplay_active_rooms/);

    assert.match(text, /# EOF/);

    assert.doesNotMatch(text, /password|secret|mnemonic/i);

    const viaManager = MonitoringManager.getInstance().getPrometheusText();

    assert.match(viaManager, /TYPE/);

    console.log("  prometheus export: OK");
}

// --- Disabled monitoring ---
{
    reset();

    const manager = MonitoringManager.getInstance();

    manager.initialize({
        enabled: false,
        providers: createProviders()
    });

    assert.equal(manager.isEnabled(), false);

    assert.equal(manager.isPrometheusEnabled(), false);

    assert.equal(manager.getSnapshot().enabled, false);

    console.log("  monitoring disabled: OK");
}

// --- Safe snapshot ---
{
    const snap = new MetricsSnapshot({
        collectedAt: Date.now(),
        enabled: true,
        collectors: { runtime: { healthy: true } },
        runtime: { cpuPercent: 1 },
        gameplay: {},
        simulation: {},
        payments: {},
        recovery: {},
        developer: {},
        system: {},
        gauges: {},
        counters: {}
    });

    const safe = snap.toSafeSummary();

    assert.equal(Object.isFrozen(safe), true);

    assert.equal(safe.runtime.cpuPercent, 1);

    console.log("  metrics snapshot: OK");
}

reset();

console.log("productionMonitoring.test.js: OK");
