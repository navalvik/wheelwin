/**
 * R7.0E — Payment / settlement gauges (read-only).
 */

import { MetricCollector } from "./MetricCollector.js";

export class PaymentMetricsCollector extends MetricCollector {

    constructor({ intervalMs = 5000 }) {

        super({ name: "payments", intervalMs });

    }

    collect({ registry, providers }) {

        const metrics = providers?.metricsService?.getSnapshot?.() ?? null;

        const pendingSessions = providers?.paymentSessionManager
            ?.getActiveSessionCount?.() ?? 0;

        const pendingEngine = providers?.paymentEngine?.getActivePaymentCount?.()
            ?? 0;

        const settlements = providers?.contractSettlementManager
            ?.getActiveSettlementCount?.() ?? 0;

        const completed = metrics?.counters?.["payments.completed"] ?? 0;

        const failed = metrics?.counters?.["payments.failed"] ?? 0;

        const paymentTiming = metrics?.metrics?.["payment.process"] ?? null;

        registry.setGauge("payments.pending_sessions", pendingSessions);

        registry.setGauge("payments.pending_engine", pendingEngine);

        registry.setGauge("payments.active_settlements", settlements);

        registry.setCounter("payments.completed", completed);

        registry.setCounter("payments.failed", failed);

        // Settlement success/failure share payment counters until dedicated events exist.
        registry.setCounter("payments.settlement_success", completed);

        registry.setCounter("payments.settlement_failure", failed);

        if (paymentTiming) {

            registry.setGauge(
                "payments.avg_duration_ms",
                paymentTiming.averageMs ?? 0
            );

            registry.setGauge(
                "payments.avg_settlement_duration_ms",
                paymentTiming.averageMs ?? 0
            );

        }

        registry.setGauge("payments.blockchain_confirmation_ms", 0);

    }

}
