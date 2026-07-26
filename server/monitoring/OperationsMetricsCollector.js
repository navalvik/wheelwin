/**
 * R9.0B — Operations gauges for MonitoringManager.
 */

import { MetricCollector } from "./MetricCollector.js";
import { SERVICE_LIFECYCLE } from "../operations/OperationsConfiguration.js";

export class OperationsMetricsCollector extends MetricCollector {

    constructor({ intervalMs = 5000 }) {

        super({ name: "operations", intervalMs });

    }

    collect({ registry, providers }) {

        const status = providers?.operationsManager?.getSafeStatus?.()
            ?? null;

        if (!status) {

            registry.setGauge("operations.available", 0);

            return;

        }

        registry.setGauge("operations.available", 1);

        registry.setGauge(
            "operations.score",
            status.operationalScore ?? 0
        );

        registry.setGauge(
            "operations.maintenance.active",
            status.maintenanceActive ? 1 : 0
        );

        registry.setGauge(
            "operations.incidents.open",
            status.incidentSummary?.open ?? 0
        );

        registry.setGauge(
            "operations.incidents.critical",
            status.incidentSummary?.openCritical ?? 0
        );

        registry.setGauge(
            "operations.kpi.availability_x10000",
            Math.round((status.kpiSummary?.availability ?? 0) * 10000)
        );

        registry.setGauge(
            "operations.kpi.latency_ms",
            status.kpiSummary?.averageLatencyMs ?? 0
        );

        registry.setGauge(
            "operations.kpi.crash_rate_x10000",
            Math.round((status.kpiSummary?.crashRate ?? 0) * 10000)
        );

        registry.setGauge(
            "operations.kpi.recovery_x10000",
            Math.round((status.kpiSummary?.recoverySuccessRate ?? 0) * 10000)
        );

        registry.setGauge(
            "operations.kpi.settlement_x10000",
            Math.round(
                (status.kpiSummary?.settlementSuccessRate ?? 0) * 10000
            )
        );

        registry.setGauge(
            "operations.sla.score",
            status.slaSummary?.score ?? 0
        );

        registry.setGauge(
            "operations.sla.failed",
            status.slaSummary?.failed ?? 0
        );

        registry.setGauge(
            "operations.sla.passed",
            status.slaSummary?.passed ?? 0
        );

        const lifecycle = status.lifecycle ?? SERVICE_LIFECYCLE.GA_ACTIVE;

        for (const name of Object.values(SERVICE_LIFECYCLE)) {

            registry.setGauge(
                `operations.lifecycle_${name.toLowerCase()}`,
                lifecycle === name ? 1 : 0
            );

        }

    }

}
