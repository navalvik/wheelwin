/**
 * R7.0F — Map classified failures → decisions.
 */

import {
    FAILURE_CATEGORY,
    FAILURE_COMPONENT,
    FAILURE_DECISION
} from "./failureTypes.js";

export class FailureDecisionEngine {

    /**
     * @param {{
     *   context: import("./FailureContext.js").FailureContext,
     *   category: string,
     *   retryPolicy: import("./RetryPolicy.js").RetryPolicy,
     *   circuitOpen?: boolean,
     *   policyAllowRetry?: boolean
     * }} input
     */
    decide({
        context,
        category,
        retryPolicy,
        circuitOpen = false,
        policyAllowRetry = true
    }) {

        if (category === FAILURE_CATEGORY.FATAL) {

            return {
                decision: FAILURE_DECISION.SHUTDOWN,
                reason: "fatal_failure",
                delayMs: 0
            };

        }

        if (category === FAILURE_CATEGORY.NON_RECOVERABLE) {

            return {
                decision: FAILURE_DECISION.FAIL,
                reason: "non_recoverable",
                delayMs: 0
            };

        }

        if (context.component === FAILURE_COMPONENT.GAMEPLAY
            || context.component === FAILURE_COMPONENT.CONFIGURATION) {

            // Gameplay / config: never retry via policy engine.
            if (category === FAILURE_CATEGORY.TRANSIENT) {

                return {
                    decision: FAILURE_DECISION.IGNORE,
                    reason: "gameplay_transient_ignore",
                    delayMs: 0
                };

            }

            return {
                decision: FAILURE_DECISION.FAIL,
                reason: "retry_forbidden_for_component",
                delayMs: 0
            };

        }

        if (circuitOpen) {

            return {
                decision: FAILURE_DECISION.ESCALATE,
                reason: "circuit_open",
                delayMs: 0
            };

        }

        if (!policyAllowRetry || !retryPolicy.allowRetry) {

            return {
                decision: FAILURE_DECISION.FAIL,
                reason: "retry_disabled",
                delayMs: 0
            };

        }

        if (!retryPolicy.canRetry(context.attempt)) {

            return {
                decision: FAILURE_DECISION.ESCALATE,
                reason: "retry_budget_exhausted",
                delayMs: 0
            };

        }

        if (category === FAILURE_CATEGORY.TRANSIENT) {

            return {
                decision: FAILURE_DECISION.RETRY_NOW,
                reason: "transient",
                delayMs: 0
            };

        }

        return {
            decision: FAILURE_DECISION.RETRY_LATER,
            reason: category === FAILURE_CATEGORY.RATE_LIMITED
                ? "rate_limited"
                : "recoverable",
            delayMs: null // filled by backoff
        };

    }

}
