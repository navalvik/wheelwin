/**
 * R7.0E — Process / runtime gauges.
 */

import { monitorEventLoopDelay, performance } from "node:perf_hooks";

import { MetricCollector } from "./MetricCollector.js";

export class RuntimeMetricsCollector extends MetricCollector {

    constructor({ intervalMs = 1000 }) {

        super({ name: "runtime", intervalMs });

        this._startedAt = Date.now();

        this._cpuPrevious = process.cpuUsage();

        this._cpuPreviousAt = performance.now();

        this._eventLoop = null;

        try {

            this._eventLoop = monitorEventLoopDelay({ resolution: 20 });

            this._eventLoop.enable();

        } catch {

            this._eventLoop = null;

        }

    }

    collect({ registry, providers }) {

        const memory = process.memoryUsage();

        const nowCpu = process.cpuUsage();

        const nowAt = performance.now();

        const elapsedUs = Math.max(1, (nowAt - this._cpuPreviousAt) * 1000);

        const userDelta = nowCpu.user - this._cpuPrevious.user;

        const systemDelta = nowCpu.system - this._cpuPrevious.system;

        const cpuPercent = Math.min(
            100,
            ((userDelta + systemDelta) / elapsedUs) * 100
        );

        this._cpuPrevious = nowCpu;

        this._cpuPreviousAt = nowAt;

        let eventLoopDelayMs = 0;

        if (this._eventLoop) {

            eventLoopDelayMs = Number(this._eventLoop.mean) / 1e6;

            this._eventLoop.reset();

        }

        registry.setGauge("runtime.uptime_ms", Date.now() - this._startedAt);

        registry.setGauge("runtime.cpu_percent", Number(cpuPercent.toFixed(3)));

        registry.setGauge("runtime.memory_rss_bytes", memory.rss);

        registry.setGauge("runtime.heap_used_bytes", memory.heapUsed);

        registry.setGauge("runtime.heap_total_bytes", memory.heapTotal);

        registry.setGauge(
            "runtime.event_loop_delay_ms",
            Number(eventLoopDelayMs.toFixed(3))
        );

        registry.setGauge(
            "runtime.node_version_major",
            Number(process.versions.node.split(".")[0]) || 0
        );

        if (providers?.lifecycleState) {

            // encoded as 1 when RUNNING for simple gauges
            registry.setGauge(
                "runtime.lifecycle_running",
                providers.lifecycleState() === "RUNNING" ? 1 : 0
            );

        }

    }

    shutdown() {

        try {

            this._eventLoop?.disable?.();

        } catch {

            // ignore
        }

    }

}
