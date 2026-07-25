/**
 * R7.0F — Failure policy gauges for MonitoringManager.
 */

import { MetricCollector } from "./MetricCollector.js";

export class FailureMetricsCollector extends MetricCollector {

    constructor({ intervalMs = 5000 }) {

        super({ name: "failure", intervalMs });

    }

    collect({ registry, providers }) {

        const status = providers?.failurePolicy?.getSafeStatus?.() ?? null;

        if (!status) {

            registry.setGauge("failure.policy_enabled", 0);

            return;

        }

        registry.setGauge("failure.policy_enabled", status.enabled ? 1 : 0);

        registry.setGauge("failure.retry_queue_size", status.retryQueueSize ?? 0);

        registry.setGauge("failure.escalation_count", status.escalationCount ?? 0);

        registry.setGauge(
            "failure.recoverable_failures",
            status.recoverableFailures ?? 0
        );

        registry.setGauge("failure.fatal_failures", status.fatalFailures ?? 0);

        registry.setCounter("failure.retry_count", status.retryCount ?? 0);

        registry.setCounter("failure.retry_success", status.retrySuccess ?? 0);

        registry.setCounter("failure.retry_failure", status.retryFailure ?? 0);

        const openCircuits = (status.circuitBreakers ?? [])
            .filter((c) => c.state === "OPEN").length;

        registry.setGauge("failure.circuits_open", openCircuits);

        registry.setGauge(
            "failure.circuits_total",
            (status.circuitBreakers ?? []).length
        );

    }

}
