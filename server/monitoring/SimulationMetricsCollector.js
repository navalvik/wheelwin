/**
 * R7.0E — Simulation gauges derived from SimulationLoop + physics.tick metrics.
 * Does not modify SimulationLoop / PhysicsEngine.
 */

import { MetricCollector } from "./MetricCollector.js";

export class SimulationMetricsCollector extends MetricCollector {

    constructor({ intervalMs = 500 }) {

        super({ name: "simulation", intervalMs });

        this._previousTickCount = 0;

        this._previousAt = Date.now();

        this._estimatedTickRate = 0;

    }

    collect({ registry, providers }) {

        const loop = providers?.simulationLoop;

        const physics = providers?.physicsEngine;

        const metrics = providers?.metricsService?.getSnapshot?.() ?? null;

        const physicsTick = metrics?.metrics?.["physics.tick"] ?? null;

        const activeSims = physics?.getActiveSimulationCount?.()
            ?? loop?.getActiveGameCount?.()
            ?? 0;

        const fixedStepMs = loop?.getFixedStepMs?.() ?? 0;

        const targetHz = fixedStepMs > 0 ? 1000 / fixedStepMs : 0;

        const sampleCount = physicsTick?.count ?? 0;

        const now = Date.now();

        const elapsedSec = Math.max(0.001, (now - this._previousAt) / 1000);

        const deltaSamples = Math.max(0, sampleCount - this._previousTickCount);

        this._estimatedTickRate = deltaSamples / elapsedSec;

        this._previousTickCount = sampleCount;

        this._previousAt = now;

        const avgLatency = physicsTick?.averageMs ?? 0;

        const maxLatency = physicsTick?.maxMs ?? 0;

        const lastLatency = physicsTick?.lastMs ?? 0;

        const tickDrift = targetHz > 0
            ? Math.max(0, targetHz - this._estimatedTickRate)
            : 0;

        registry.setGauge("simulation.active", activeSims);

        registry.setGauge("simulation.running", loop?.isRunning?.() ? 1 : 0);

        registry.setGauge(
            "simulation.tick_rate_hz",
            Number(this._estimatedTickRate.toFixed(3))
        );

        registry.setGauge(
            "simulation.target_tick_rate_hz",
            Number(targetHz.toFixed(3))
        );

        registry.setGauge(
            "simulation.tick_drift_hz",
            Number(tickDrift.toFixed(3))
        );

        registry.setGauge(
            "simulation.physics_updates_per_sec",
            Number(this._estimatedTickRate.toFixed(3))
        );

        registry.setGauge(
            "simulation.avg_latency_ms",
            Number(avgLatency.toFixed(3))
        );

        registry.setGauge(
            "simulation.max_latency_ms",
            Number(maxLatency.toFixed(3))
        );

        registry.setGauge(
            "simulation.last_latency_ms",
            Number(lastLatency.toFixed(3))
        );

        // Skipped ticks / queue — not exposed by engines; report 0 observationally.
        registry.setGauge("simulation.skipped_ticks", 0);

        registry.setGauge("simulation.queue_size", activeSims);

    }

}
