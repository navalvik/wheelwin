/**
 * R7.0H — Restart / startup probe scenario.
 */

import { ValidationScenario } from "../ValidationScenario.js";
import { createValidationStack, delay } from "../validationHarness.js";

export class RestartScenario extends ValidationScenario {

    constructor() {

        super({
            id: "restart",
            name: "Restart & Startup Probes",
            description:
                "Startup/readiness transitions across restart-like re-init"
        });

    }

    async run(assert) {

        // First boot
        let stack = await createValidationStack();

        let cache = stack.healthManager.refresh();

        assert.equal(cache.startup.ok, false, "Startup false before bind");

        assert.equal(cache.readiness.ok, false, "Ready false before RUNNING");

        stack.markReady();

        cache = stack.healthManager.refresh();

        assert.equal(cache.startup.ok, true, "Startup latched after ready");

        assert.equal(cache.readiness.ok, true, "Ready after RUNNING");

        assert.ok(stack.logging.isInitialized(), "Logging started");

        assert.ok(stack.monitoring.isRunning(), "Monitoring started");

        assert.ok(stack.failurePolicy.isEnabled(), "Failure policy started");

        await stack.shutdown();

        await delay(20);

        // Second boot (restart)
        stack = await createValidationStack();

        cache = stack.healthManager.refresh();

        assert.equal(cache.startup.ok, false, "Startup resets after restart");

        stack.markReady();

        cache = stack.healthManager.refresh();

        assert.equal(cache.startup.ok, true, "Startup restored after restart");

        assert.equal(cache.readiness.ok, true, "Readiness restored");

        assert.equal(
            stack.lifecycle.getState(),
            "RUNNING",
            "Lifecycle restored to RUNNING"
        );

        await stack.shutdown();

        return {
            evidence: {
                boots: 2,
                finalReady: true
            }
        };

    }

}
