/**
 * R7.0G — Production health / readiness / deployment probe tests.
 */

import assert from "node:assert/strict";

import { DeploymentManager } from "../deployment/DeploymentManager.js";
import { HealthManager } from "../deployment/HealthManager.js";
import { DeploymentProfile } from "../deployment/DeploymentProfile.js";
import { StartupProbe } from "../deployment/health/StartupProbe.js";
import { LivenessProbe } from "../deployment/health/LivenessProbe.js";
import { ReadinessProbe } from "../deployment/health/ReadinessProbe.js";
import { HealthService } from "../services/HealthService.js";
import { MonitoringManager } from "../monitoring/MonitoringManager.js";

function delay(ms) {

    return new Promise((resolve) => setTimeout(resolve, ms));

}

function reset() {

    DeploymentManager.resetForTests();

    MonitoringManager.resetForTests();

}

function createSignals(overrides = {}) {

    return {
        lifecycleState: "RUNNING",
        lifecycleInitialized: true,
        configurationLoaded: true,
        loggingActive: true,
        monitoringInitialized: true,
        monitoringActive: true,
        monitoringRequired: true,
        failurePolicyInitialized: true,
        httpListening: true,
        socketListening: true,
        memory: process.memoryUsage(),
        eventLoopDelayMs: 1.2,
        activeGames: 2,
        activeRooms: 3,
        unrecoverableFailure: false,
        ...overrides
    };

}

async function main() {

    // --- Deployment profiles ---

    {
        const dev = DeploymentProfile.resolve("development");

        assert.equal(dev.name, "development");

        assert.equal(dev.readinessStrict, false);

        const prod = DeploymentProfile.resolve("production");

        assert.equal(prod.name, "production");

        assert.equal(prod.readinessStrict, true);

        assert.ok(DeploymentProfile.isValidName("staging"));

        assert.equal(DeploymentProfile.isValidName("invalid"), false);

        console.log("  deployment profiles: OK");
    }

    // --- Startup probe latch ---

    {
        const probe = new StartupProbe();

        const incomplete = probe.evaluate(createSignals({
            httpListening: false
        }));

        assert.equal(incomplete.ok, false);

        assert.equal(probe.isComplete(), false);

        const complete = probe.evaluate(createSignals());

        assert.equal(complete.ok, true);

        assert.equal(probe.isComplete(), true);

        // Permanent latch even if signals degrade.
        const latched = probe.evaluate(createSignals({
            httpListening: false
        }));

        assert.equal(latched.ok, true);

        console.log("  startup probe: OK");
    }

    // --- Readiness transitions ---

    {
        const probe = new ReadinessProbe({ strict: true });

        const ready = probe.evaluate(createSignals());

        assert.equal(ready.ok, true);

        const draining = probe.evaluate(createSignals({
            lifecycleState: "DRAINING"
        }));

        assert.equal(draining.ok, false);

        assert.equal(draining.reason, "draining");

        const starting = probe.evaluate(createSignals({
            lifecycleState: "STARTING"
        }));

        assert.equal(starting.ok, false);

        console.log("  readiness transitions: OK");
    }

    // --- Liveness ---

    {
        const probe = new LivenessProbe();

        assert.equal(probe.evaluate(createSignals({
            lifecycleState: "DRAINING"
        })).ok, true);

        const dead = probe.evaluate(createSignals({
            unrecoverableFailure: true,
            unrecoverableFailureReason: "invariant"
        }));

        assert.equal(dead.ok, false);

        console.log("  liveness transitions: OK");
    }

    // --- HealthManager snapshots + graceful drain ---

    {
        reset();

        let lifecycle = "STARTING";

        let httpListening = false;

        const manager = HealthManager.getInstance().initialize({
            enabled: true,
            profile: DeploymentProfile.resolve("production", {
                probeRefreshIntervalMs: 50
            }),
            probeRefreshIntervalMs: 50,
            providers: {
                lifecycleState: () => lifecycle,
                lifecycleInitialized: () => true,
                configurationLoaded: () => true,
                loggingActive: () => true,
                monitoringInitialized: () => true,
                monitoringActive: () => true,
                monitoringRequired: () => true,
                failurePolicyInitialized: () => true,
                httpListening: () => httpListening,
                socketListening: () => httpListening,
                activeGames: () => 1,
                activeRooms: () => 1
            }
        });

        let cache = manager.refresh();

        assert.equal(cache.readiness.ok, false);

        assert.equal(cache.startup.ok, false);

        assert.equal(cache.liveness.ok, true);

        httpListening = true;

        lifecycle = "RUNNING";

        cache = manager.refresh();

        assert.equal(cache.startup.ok, true);

        assert.equal(cache.readiness.ok, true);

        assert.equal(manager.getReadinessResponse().ready, true);

        assert.equal(manager.getLivenessResponse().live, true);

        assert.equal(manager.getStartupResponse().startup, true);

        lifecycle = "DRAINING";

        cache = manager.refresh();

        assert.equal(cache.readiness.ok, false);

        assert.equal(cache.liveness.ok, true);

        assert.ok(cache.stats.readinessTransitions >= 1);

        const safe = manager.getSafeStatus();

        assert.ok(!JSON.stringify(safe).includes("stack"));

        assert.ok(!JSON.stringify(safe).includes("password"));

        console.log("  health snapshots + drain readiness: OK");
    }

    // --- HealthService delegation ---

    {
        reset();

        const healthManager = HealthManager.getInstance().initialize({
            enabled: true,
            profile: DeploymentProfile.resolve("development"),
            providers: {
                lifecycleState: () => "RUNNING",
                lifecycleInitialized: () => true,
                configurationLoaded: () => true,
                loggingActive: () => true,
                monitoringInitialized: () => true,
                monitoringActive: () => false,
                monitoringRequired: () => false,
                failurePolicyInitialized: () => true,
                httpListening: () => true,
                socketListening: () => true
            }
        });

        healthManager.refresh();

        const health = new HealthService({
            logger: { error() {}, info() {} },
            productionConfig: { nodeEnv: "development" }
        });

        health.setLifecycleState("RUNNING");

        health.setHealthManager(healthManager);

        const snapshot = health.getHealthSnapshot();

        assert.equal(snapshot.ready, true);

        assert.ok(snapshot.deployment);

        assert.ok(snapshot.probes?.readiness);

        console.log("  health service delegation: OK");
    }

    // --- Monitoring integration ---

    {
        reset();

        const healthManager = HealthManager.getInstance().initialize({
            enabled: true,
            profile: DeploymentProfile.resolve("staging"),
            providers: {
                lifecycleState: () => "RUNNING",
                lifecycleInitialized: () => true,
                configurationLoaded: () => true,
                loggingActive: () => true,
                monitoringInitialized: () => true,
                monitoringActive: () => true,
                failurePolicyInitialized: () => true,
                httpListening: () => true,
                socketListening: () => true
            }
        });

        healthManager.refresh();

        MonitoringManager.resetForTests();

        const monitoring = MonitoringManager.getInstance();

        monitoring.initialize({
            enabled: true,
            intervals: { systemMs: 20 },
            providers: {
                deploymentHealth: healthManager,
                lifecycleState: () => "RUNNING",
                environment: () => "test",
                profile: () => "staging",
                version: () => "0.0.0-test"
            }
        });

        await delay(60);

        const snap = monitoring.getSnapshot();

        assert.ok(snap.deployment);

        assert.equal(snap.deployment.readyOk, true);

        monitoring.shutdown();

        console.log("  monitoring integration: OK");
    }

    // --- Performance under load ---

    {
        reset();

        const manager = HealthManager.getInstance().initialize({
            enabled: true,
            profile: DeploymentProfile.resolve("production"),
            providers: {
                lifecycleState: () => "RUNNING",
                lifecycleInitialized: () => true,
                configurationLoaded: () => true,
                loggingActive: () => true,
                monitoringInitialized: () => true,
                monitoringActive: () => true,
                failurePolicyInitialized: () => true,
                httpListening: () => true,
                socketListening: () => true
            }
        });

        manager.refresh();

        const start = Date.now();

        for (let i = 0; i < 2000; i += 1) {

            manager.getReadinessResponse();

            manager.getLivenessResponse();

            manager.getStartupResponse();

            manager.getSafeStatus();

        }

        const elapsed = Date.now() - start;

        assert.ok(elapsed < 500, `cached probe reads too slow: ${elapsed}ms`);

        console.log("  performance under load: OK");
    }

    reset();

    console.log("deploymentHealth.test.js: all passed");

}

main().catch((error) => {

    console.error(error);

    process.exit(1);

});
