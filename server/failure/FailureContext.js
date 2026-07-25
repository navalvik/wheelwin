/**
 * R7.0F — Structured failure context (correlates with LoggingManager).
 */

import { LogCorrelation } from "../logging/LogCorrelation.js";

export class FailureContext {

    /**
     * @param {{
     *   component: string,
     *   operation: string,
     *   error?: Error|null,
     *   code?: string|null,
     *   attempt?: number,
     *   maxAttempts?: number,
     *   fields?: object
     * }} input
     */
    constructor(input) {

        const correlated = LogCorrelation.resolve(input.fields ?? {});

        this.traceId = correlated.traceId;

        this.timestamp = Date.now();

        this.component = input.component;

        this.operation = input.operation;

        this.error = input.error ?? null;

        this.code = input.code
            ?? input.error?.code
            ?? input.error?.name
            ?? null;

        this.message = input.error?.message
            ?? input.code
            ?? "unknown_failure";

        this.attempt = Number.isFinite(input.attempt) ? input.attempt : 1;

        this.maxAttempts = Number.isFinite(input.maxAttempts)
            ? input.maxAttempts
            : 1;

        this.fields = Object.freeze({ ...correlated });

        // Filled by classifier / decision engine
        this.failureType = null;

        this.decision = null;

        this.reason = null;

        this.delayMs = null;

    }

    toLogFields() {

        return {
            traceId: this.traceId,
            component: this.component,
            operation: this.operation,
            failureType: this.failureType,
            attempt: this.attempt,
            maxAttempts: this.maxAttempts,
            decision: this.decision,
            reason: this.reason,
            delayMs: this.delayMs,
            code: this.code,
            ...this.fields
        };

    }

}
