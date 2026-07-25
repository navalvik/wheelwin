/**
 * R7.0H — Graceful shutdown / drain scenario.
 */

import { ValidationScenario } from "../ValidationScenario.js";
import { createValidationStack, delay } from "../validationHarness.js";
import { APPLICATION_LIFECYCLE } from "../../lifecycle/ApplicationLifecycleStates.js";

export class GracefulShutdownScenario extends ValidationScenario {

    constructor() {

        super({
            id: "graceful-shutdown",
            name: "Graceful Shutdown",
            description:
                "DRAINING rejects new work, finishes activity, closes cleanly"
        });

    }

    async run(assert) {

        const stack = await createValidationStack({ drainTimeoutMs: 300 });

        stack.markReady();

        stack.state.games = 2;

        stack.state.rooms = 2;

        assert.equal(
            stack.lifecycle.isAcceptingNewWork(),
            true,
            "Accepting work while RUNNING"
        );

        const drainPromise = stack.lifecycle.beginDrain({
            reason: "validation_drain"
        });

        await delay(10);

        assert.equal(
            stack.lifecycle.getState(),
            APPLICATION_LIFECYCLE.DRAINING,
            "Entered DRAINING"
        );

        assert.equal(
            stack.lifecycle.isAcceptingNewWork(),
            false,
            "Rejects new rooms while draining"
        );

        stack.healthManager.refresh();

        assert.equal(
            stack.healthManager.getReadinessResponse().ready,
            false,
            "Readiness false during drain"
        );

        assert.equal(
            stack.healthManager.getLivenessResponse().live,
            true,
            "Liveness true during drain"
        );

        // Finish active games so drain can complete.
        stack.state.games = 0;

        const drainResult = await drainPromise;

        stack.lifecycle.markStopped({ forced: drainResult.forced === true });

        assert.equal(
            stack.lifecycle.getState(),
            APPLICATION_LIFECYCLE.STOPPED,
            "Reached STOPPED"
        );

        assert.ok(
            Number.isFinite(drainResult.durationMs),
            "Drain duration recorded"
        );

        await stack.shutdown();

        return {
            evidence: {
                drainDurationMs: drainResult.durationMs,
                forced: drainResult.forced === true
            }
        };

    }

}
