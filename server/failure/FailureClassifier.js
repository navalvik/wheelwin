/**
 * R7.0F — Classify failures into categories.
 */

import { FAILURE_CATEGORY, FAILURE_COMPONENT } from "./failureTypes.js";

const RATE_LIMIT_CODES = new Set([
    "429",
    "RATE_LIMIT",
    "RATE_LIMITED"
]);

const FATAL_CODES = new Set([
    "CONFIG_CORRUPT",
    "INVARIANT_VIOLATION",
    "FATAL",
    "CONFIGURATION_ERROR"
]);

const NON_RECOVERABLE_CODES = new Set([
    "INVALID_SIGNATURE",
    "INVALID_CONTRACT",
    "CORRUPTED_PAYLOAD",
    "VALIDATION_ERROR",
    "ConfigurationError"
]);

export class FailureClassifier {

    /**
     * @param {import("./FailureContext.js").FailureContext} context
     * @returns {string} FAILURE_CATEGORY
     */
    classify(context) {

        const code = String(context.code ?? "").toUpperCase();

        const message = String(context.message ?? "").toLowerCase();

        if (FATAL_CODES.has(code)
            || message.includes("invariant")
            || message.includes("configuration corruption")) {

            return FAILURE_CATEGORY.FATAL;

        }

        if (context.component === FAILURE_COMPONENT.CONFIGURATION
            || NON_RECOVERABLE_CODES.has(code)
            || code.includes("VALIDATION")
            || message.includes("invalid signature")
            || message.includes("corrupted payload")) {

            return FAILURE_CATEGORY.NON_RECOVERABLE;

        }

        if (code === "429"
            || RATE_LIMIT_CODES.has(code)
            || message.includes("rate limit")
            || message.includes("too many requests")
            || message.includes("throttl")) {

            return FAILURE_CATEGORY.RATE_LIMITED;

        }

        if (context.component === FAILURE_COMPONENT.GAMEPLAY) {

            // Gameplay: reconnects are transient; authority never retries.
            if (message.includes("reconnect") || code.includes("RECONNECT")) {

                return FAILURE_CATEGORY.TRANSIENT;

            }

            return FAILURE_CATEGORY.NON_RECOVERABLE;

        }

        if (message.includes("timeout")
            || message.includes("temporar")
            || message.includes("econn")
            || message.includes("network")
            || code.includes("TIMEOUT")
            || code.includes("ECONN")) {

            return FAILURE_CATEGORY.RECOVERABLE;

        }

        if (context.component === FAILURE_COMPONENT.NETWORK
            || context.component === FAILURE_COMPONENT.BLOCKCHAIN
            || context.component === FAILURE_COMPONENT.PAYMENT) {

            return FAILURE_CATEGORY.RECOVERABLE;

        }

        return FAILURE_CATEGORY.RECOVERABLE;

    }

}
