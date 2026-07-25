/**
 * R7.0H — Deployment probe endpoints under sustained load.
 */

import { ValidationScenario } from "../ValidationScenario.js";
import {
    createValidationStack,
    delay,
    average,
    containsSensitive
} from "../validationHarness.js";

export class DeploymentScenario extends ValidationScenario {

    constructor() {

        super({
            id: "deployment",
            name: "Deployment Probes",
            description: "/health /ready /live /startup under sustained load"
        });

    }

    async run(assert) {

        const stack = await createValidationStack();

        const before = stack.healthManager.refresh();

        assert.equal(before.startup.ok, false, "/startup pending before bind");

        assert.equal(before.readiness.ok, false, "/ready pending before bind");

        assert.equal(before.liveness.ok, true, "/live true early");

        stack.markReady();

        const latencies = [];

        for (let i = 0; i < 200; i += 1) {

            const started = performance.now();

            const startup = stack.healthManager.getStartupResponse();

            const ready = stack.healthManager.getReadinessResponse();

            const live = stack.healthManager.getLivenessResponse();

            const health = stack.healthService.getHealthSnapshot();

            latencies.push(performance.now() - started);

            if (i === 0) {

                assert.equal(startup.startup, true, "/startup ok");

                assert.equal(ready.ready, true, "/ready ok");

                assert.equal(live.live, true, "/live ok");

                assert.equal(health.ready, true, "/health ready");

                assert.ok(!containsSensitive(JSON.stringify(startup)));

                assert.ok(!containsSensitive(JSON.stringify(ready)));

                assert.ok(!containsSensitive(JSON.stringify(live)));

                assert.ok(!containsSensitive(JSON.stringify(health)));

            }

        }

        stack.state.games = 0;

        const drainPromise = stack.lifecycle.beginDrain({
            reason: "deployment_probe_drain"
        });

        await delay(15);

        stack.healthManager.refresh();

        assert.equal(
            stack.healthManager.getReadinessResponse().ready,
            false,
            "/ready false while draining"
        );

        assert.equal(
            stack.healthManager.getLivenessResponse().live,
            true,
            "/live true while draining"
        );

        await drainPromise;

        stack.lifecycle.markStopped({ forced: false });

        const avg = average(latencies);

        assert.lessThan(avg, 20, "Probe response avg under 20ms");

        await stack.shutdown();

        return {
            evidence: {
                iterations: latencies.length,
                avgProbeLatencyMs: Number(avg.toFixed(3)),
                profile: stack.deployment.getProfile()?.name
            },
            metrics: {
                avgHttpLatencyMs: Number(avg.toFixed(3))
            }
        };

    }

}
