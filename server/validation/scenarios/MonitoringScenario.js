/**
 * R7.0H — Monitoring & metrics scenario.
 */

import { ValidationScenario } from "../ValidationScenario.js";
import {
    createValidationStack,
    delay,
    containsSensitive
} from "../validationHarness.js";

export class MonitoringScenario extends ValidationScenario {

    constructor() {

        super({
            id: "monitoring",
            name: "Monitoring & Metrics",
            description:
                "Collectors, freshness, Prometheus, health snapshots"
        });

    }

    async run(assert) {

        const stack = await createValidationStack();

        stack.markReady();

        stack.state.rooms = 3;

        stack.state.games = 2;

        const collectStart = performance.now();

        stack.monitoring.collectNow();

        const collectMs = performance.now() - collectStart;

        await delay(60);

        const snap = stack.monitoring.getSnapshot();

        assert.equal(snap.enabled, true, "Monitoring enabled");

        assert.ok(snap.collectedAt > 0, "Snapshot has timestamp");

        assert.equal(snap.gameplay.activeRooms, 3);

        assert.equal(snap.gameplay.activeGames, 2);

        const freshness = Date.now() - snap.collectedAt;

        assert.lessThan(freshness, 5000, "Metrics freshness under 5s");

        const text = stack.monitoring.getPrometheusText();

        assert.includes(text, "TYPE", "Prometheus TYPE lines present");

        assert.includes(text, "EOF", "Prometheus EOF present");

        assert.ok(!containsSensitive(text), "Prometheus has no secrets");

        const healthStatus = stack.monitoring.getHealthStatus();

        assert.equal(healthStatus.running, true, "Collectors running");

        assert.ok(
            (healthStatus.collectorCount ?? 0) >= 1,
            "At least one collector"
        );

        const healthSnap = stack.healthService.getHealthSnapshot();

        assert.ok(healthSnap.monitoring, "Health includes monitoring");

        assert.ok(!containsSensitive(JSON.stringify(healthSnap)), "Health safe");

        await stack.shutdown();

        return {
            evidence: {
                freshnessMs: freshness,
                collectorCount: healthStatus.collectorCount,
                prometheusBytes: text.length
            },
            metrics: {
                monitoringOverheadMs: Number(collectMs.toFixed(3))
            }
        };

    }

}
