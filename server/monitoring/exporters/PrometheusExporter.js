/**
 * R7.0E — Prometheus / OpenMetrics text exporter (read-only).
 */

function sanitizeMetricName(name) {

    return String(name)
        .replace(/[^a-zA-Z0-9_:]/g, "_")
        .replace(/^[^a-zA-Z_:]/, "_");

}

export class PrometheusExporter {

    /**
     * @param {import("../MetricsSnapshot.js").MetricsSnapshot} snapshot
     * @param {{ namespace?: string }} [options]
     */
    export(snapshot, { namespace = "wheelwin" } = {}) {

        const lines = [];

        const writeGauge = (name, value, help) => {

            if (!Number.isFinite(value)) {

                return;

            }

            const metric = sanitizeMetricName(`${namespace}_${name}`);

            if (help) {

                lines.push(`# HELP ${metric} ${help}`);

            }

            lines.push(`# TYPE ${metric} gauge`);

            lines.push(`${metric} ${value}`);

        };

        const writeCounter = (name, value, help) => {

            if (!Number.isFinite(value)) {

                return;

            }

            const metric = sanitizeMetricName(`${namespace}_${name}`);

            if (help) {

                lines.push(`# HELP ${metric} ${help}`);

            }

            lines.push(`# TYPE ${metric} counter`);

            lines.push(`${metric} ${value}`);

        };

        const runtime = snapshot.runtime ?? {};

        writeGauge("runtime_uptime_ms", runtime.uptimeMs, "Process uptime in ms");

        writeGauge("runtime_cpu_percent", runtime.cpuPercent, "CPU usage percent");

        writeGauge("runtime_memory_rss_bytes", runtime.memoryRssBytes, "RSS bytes");

        writeGauge("runtime_heap_used_bytes", runtime.heapUsedBytes, "Heap used");

        writeGauge(
            "runtime_event_loop_delay_ms",
            runtime.eventLoopDelayMs,
            "Mean event loop delay"
        );

        const gameplay = snapshot.gameplay ?? {};

        writeGauge("gameplay_active_rooms", gameplay.activeRooms);

        writeGauge("gameplay_active_games", gameplay.activeGames);

        writeGauge("gameplay_active_players", gameplay.activePlayers);

        writeGauge("gameplay_active_setup_sessions", gameplay.activeSetupSessions);

        writeCounter("gameplay_games_created", gameplay.gamesCreated);

        writeCounter("gameplay_games_completed", gameplay.gamesCompleted);

        const simulation = snapshot.simulation ?? {};

        writeGauge("simulation_tick_rate_hz", simulation.tickRateHz);

        writeGauge("simulation_tick_drift_hz", simulation.tickDriftHz);

        writeGauge("simulation_avg_latency_ms", simulation.avgLatencyMs);

        writeGauge("simulation_physics_updates_per_sec", simulation.physicsUpdatesPerSec);

        const payments = snapshot.payments ?? {};

        writeGauge("payments_pending", payments.pending);

        writeCounter("payments_completed", payments.completed);

        writeCounter("payments_failed", payments.failed);

        const recovery = snapshot.recovery ?? {};

        writeGauge("recovery_active", recovery.active);

        writeGauge("recovery_queue_size", recovery.queueSize);

        writeCounter("recovery_reconnects", recovery.reconnects);

        const developer = snapshot.developer ?? {};

        writeGauge("developer_console_connections", developer.consoleConnections);

        writeCounter("developer_log_events", developer.logEventsGenerated);

        const system = snapshot.system ?? {};

        writeGauge("system_open_sockets", system.openSockets);

        writeGauge("system_http_requests_per_sec", system.httpRequestsPerSec);

        writeCounter("system_http_requests_total", system.httpRequestsTotal);

        writeCounter("system_http_errors_total", system.httpErrorsTotal);

        // Flat gauges/counters for completeness
        for (const [name, value] of Object.entries(snapshot.gauges ?? {})) {

            writeGauge(`gauge_${name}`, value);

        }

        for (const [name, value] of Object.entries(snapshot.counters ?? {})) {

            writeCounter(`counter_${name}`, value);

        }

        lines.push("# EOF");

        return `${lines.join("\n")}\n`;

    }

}
