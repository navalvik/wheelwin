/**
 * R7.0E — System / socket / HTTP gauges.
 */

import { MetricCollector } from "./MetricCollector.js";

export class SystemMetricsCollector extends MetricCollector {

    constructor({ intervalMs = 5000 }) {

        super({ name: "system", intervalMs });

        this._previousHttp = { count: 0, at: Date.now() };

        this._previousWarnings = 0;

    }

    collect({ registry, providers }) {

        const sockets = providers?.socketGateway?.getConnectedSocketCount?.()
            ?? 0;

        const consoleSockets = providers?.consoleGateway
            ?.getConnectedConsoleCount?.() ?? 0;

        const http = providers?.httpStats?.() ?? { requests: 0, errors: 0, totalLatencyMs: 0 };

        const now = Date.now();

        const elapsedSec = Math.max(0.001, (now - this._previousHttp.at) / 1000);

        const deltaReq = Math.max(0, http.requests - this._previousHttp.count);

        const rps = deltaReq / elapsedSec;

        this._previousHttp = { count: http.requests, at: now };

        const avgLatency = http.requests > 0
            ? http.totalLatencyMs / http.requests
            : 0;

        const errorRate = http.requests > 0
            ? http.errors / http.requests
            : 0;

        const logging = providers?.loggingManager?.getSafeStatus?.();

        const warnings = logging?.stats?.written ?? 0;

        const warnPerSec = Math.max(0, warnings - this._previousWarnings)
            / elapsedSec;

        this._previousWarnings = warnings;

        registry.setGauge("system.open_sockets", sockets);

        registry.setGauge("system.socketio_clients", sockets + consoleSockets);

        registry.setGauge("system.http_requests_per_sec", Number(rps.toFixed(3)));

        registry.setGauge(
            "system.http_avg_latency_ms",
            Number(avgLatency.toFixed(3))
        );

        registry.setGauge("system.http_error_rate", Number(errorRate.toFixed(5)));

        registry.setGauge(
            "system.warnings_per_sec",
            Number(warnPerSec.toFixed(3))
        );

        registry.setCounter("system.http_requests_total", http.requests);

        registry.setCounter("system.http_errors_total", http.errors);

        // File descriptors — best-effort on platforms that expose it.
        let fdCount = 0;

        try {

            if (typeof process.getActiveResourcesInfo === "function") {

                fdCount = process.getActiveResourcesInfo().length;

            }

        } catch {

            fdCount = 0;

        }

        registry.setGauge("system.active_resources", fdCount);

    }

}
