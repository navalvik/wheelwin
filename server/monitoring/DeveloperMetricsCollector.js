/**
 * R7.0E — Developer console / auth / logging gauges.
 */

import { MetricCollector } from "./MetricCollector.js";

export class DeveloperMetricsCollector extends MetricCollector {

    constructor({ intervalMs = 5000 }) {

        super({ name: "developer", intervalMs });

    }

    collect({ registry, providers }) {

        const consoleConnections = providers?.consoleGateway
            ?.getConnectedConsoleCount?.() ?? 0;

        const logging = providers?.loggingManager?.getSafeStatus?.() ?? null;

        const logWritten = logging?.stats?.written ?? 0;

        const auditRecent = providers?.loggingManager
            ?.getRecentRecords?.({ channel: "audit", limit: 1000 })?.length
            ?? 0;

        registry.setGauge("developer.console_connections", consoleConnections);

        registry.setGauge(
            "developer.authenticated_sessions",
            consoleConnections
        );

        registry.setCounter(
            "developer.failed_auth_attempts",
            providers?.metricsService?.getCounter?.("developer.auth.failed")
                ?? 0
        );

        registry.setGauge("developer.audit_events_buffered", auditRecent);

        registry.setCounter("developer.log_events_generated", logWritten);

    }

}
