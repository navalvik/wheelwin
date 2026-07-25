/**
 * R8.0B — Release metadata gauges for MonitoringManager.
 */

import { MetricCollector } from "./MetricCollector.js";

export class ReleaseMetricsCollector extends MetricCollector {

    constructor({ intervalMs = 5000 }) {

        super({ name: "release", intervalMs });

    }

    collect({ registry, providers }) {

        const status = providers?.releaseManager?.getSafeStatus?.() ?? null;

        if (!status) {

            registry.setGauge("release.initialized", 0);

            return;

        }

        registry.setGauge("release.initialized", status.initialized ? 1 : 0);

        const channel = status.channel ?? "unknown";

        for (const name of [
            "development",
            "internal",
            "rc",
            "beta",
            "production"
        ]) {

            registry.setGauge(
                `release.channel_${name}`,
                channel === name ? 1 : 0
            );

        }

        registry.setGauge(
            "release.has_fingerprint",
            status.fingerprint && status.fingerprint !== "unbuilt" ? 1 : 0
        );

        registry.setGauge(
            "release.verified",
            status.status === "verified" ? 1 : 0
        );

        if (status.builtAt) {

            const ts = Date.parse(status.builtAt);

            if (Number.isFinite(ts)) {

                registry.setGauge("release.build_timestamp_ms", ts);

            }

        }

    }

}
