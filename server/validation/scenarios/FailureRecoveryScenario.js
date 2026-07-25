/**
 * R7.0H — Failure recovery policy scenario.
 */

import { ValidationScenario } from "../ValidationScenario.js";
import { createValidationStack, delay } from "../validationHarness.js";
import {
    FAILURE_DECISION,
    FAILURE_CATEGORY
} from "../../failure/failureTypes.js";

export class FailureRecoveryScenario extends ValidationScenario {

    constructor() {

        super({
            id: "failure-recovery",
            name: "Failure Recovery",
            description:
                "Retries, circuit breakers, escalation — no gameplay corruption"
        });

    }

    async run(assert) {

        const stack = await createValidationStack();

        stack.markReady();

        const policy = stack.failurePolicy;

        // Gameplay must never retry.
        const gameplay = policy.decide({
            component: "gameplay",
            operation: "tick",
            error: new Error("transient glitch"),
            attempt: 1
        });

        assert.equal(
            gameplay.decision,
            FAILURE_DECISION.FAIL,
            "Gameplay failures do not retry"
        );

        // Recoverable blockchain → retry later
        const first = policy.decide({
            component: "blockchain",
            operation: "getTransactions",
            error: new Error("temporary network timeout"),
            attempt: 1
        });

        assert.equal(first.category, FAILURE_CATEGORY.RECOVERABLE);

        assert.equal(first.decision, FAILURE_DECISION.RETRY_LATER);

        let recovered = false;

        const jobId = policy.scheduleRetry({
            decision: first,
            execute: async () => {

                recovered = true;

                policy.reportSuccess({
                    component: "blockchain",
                    operation: "getTransactions"
                });

            }
        });

        assert.ok(jobId, "Retry scheduled via RetryScheduler");

        await delay((first.delayMs ?? 0) + 80);

        assert.equal(recovered, true, "Retry executed successfully");

        // Trip circuit
        for (let i = 0; i < 5; i += 1) {

            policy.decide({
                component: "blockchain",
                operation: "poll",
                error: new Error("temporary delay"),
                attempt: 1
            });

        }

        const status = policy.getSafeStatus();

        const open = status.circuitBreakers
            .filter((c) => c.state === "OPEN").length;

        assert.greaterThan(open, 0, "Circuit opened after repeated failures");

        assert.ok(
            !JSON.stringify(status).includes("stack"),
            "No stack traces in status"
        );

        // Escalation path when budget exhausted
        const exhausted = policy.decide({
            component: "network",
            operation: "http",
            error: new Error("temporary network"),
            attempt: 10
        });

        assert.ok(
            exhausted.decision === FAILURE_DECISION.ESCALATE
                || exhausted.decision === FAILURE_DECISION.FAIL,
            "Budget exhaustion escalates or fails"
        );

        await stack.shutdown();

        return {
            evidence: {
                gameplayDecision: gameplay.decision,
                retrySuccess: recovered,
                circuitsOpen: open,
                retryCount: status.retryCount,
                escalations: status.escalationCount
            },
            metrics: {
                retryOverheadMs: first.delayMs ?? 0
            }
        };

    }

}
