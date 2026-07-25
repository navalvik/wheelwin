/**
 * R7.0F — Retry policy limits (attempts / deadline / budget).
 */

export class RetryPolicy {

    /**
     * @param {{
     *   maxAttempts?: number,
     *   initialDelayMs?: number,
     *   maxDelayMs?: number,
     *   deadlineMs?: number|null,
     *   budget?: number|null,
     *   allowRetry?: boolean
     * }} options
     */
    constructor({
        maxAttempts = 3,
        initialDelayMs = 200,
        maxDelayMs = 30_000,
        deadlineMs = null,
        budget = null,
        allowRetry = true
    } = {}) {

        this.maxAttempts = Math.max(1, maxAttempts);

        this.initialDelayMs = Math.max(0, initialDelayMs);

        this.maxDelayMs = Math.max(this.initialDelayMs, maxDelayMs);

        this.deadlineMs = deadlineMs;

        this.budget = budget;

        this.allowRetry = allowRetry === true;

        this._startedAt = Date.now();

        this._spent = 0;

    }

    canRetry(attempt) {

        if (!this.allowRetry) {

            return false;

        }

        if (attempt >= this.maxAttempts) {

            return false;

        }

        if (this.deadlineMs != null
            && Date.now() - this._startedAt >= this.deadlineMs) {

            return false;

        }

        if (this.budget != null && this._spent >= this.budget) {

            return false;

        }

        return true;

    }

    consumeBudget(amount = 1) {

        this._spent += amount;

    }

    snapshot() {

        return {
            maxAttempts: this.maxAttempts,
            initialDelayMs: this.initialDelayMs,
            maxDelayMs: this.maxDelayMs,
            deadlineMs: this.deadlineMs,
            budget: this.budget,
            spent: this._spent,
            allowRetry: this.allowRetry
        };

    }

}
