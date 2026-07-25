/**
 * R7.0F — Backoff delay calculators.
 */

import { BACKOFF_STRATEGY } from "./failureTypes.js";

export class BackoffStrategy {

    /**
     * @param {{
     *   strategy?: string,
     *   initialDelayMs?: number,
     *   maxDelayMs?: number,
     *   multiplier?: number
     * }} options
     */
    constructor({
        strategy = BACKOFF_STRATEGY.EXPONENTIAL_JITTER,
        initialDelayMs = 200,
        maxDelayMs = 30_000,
        multiplier = 2
    } = {}) {

        this._strategy = strategy;

        this._initial = Math.max(0, initialDelayMs);

        this._max = Math.max(this._initial, maxDelayMs);

        this._multiplier = Math.max(1, multiplier);

    }

    /**
     * @param {number} attempt 1-based attempt that just failed
     * @returns {number} delay before next attempt
     */
    nextDelayMs(attempt) {

        const n = Math.max(1, attempt);

        let delay;

        switch (this._strategy) {

            case BACKOFF_STRATEGY.FIXED:
                delay = this._initial;
                break;

            case BACKOFF_STRATEGY.LINEAR:
                delay = this._initial * n;
                break;

            case BACKOFF_STRATEGY.EXPONENTIAL:
                delay = this._initial * (this._multiplier ** (n - 1));
                break;

            case BACKOFF_STRATEGY.EXPONENTIAL_JITTER:
            default: {
                const base = this._initial * (this._multiplier ** (n - 1));

                const capped = Math.min(this._max, base);

                // Full jitter: random in [0, capped]
                delay = Math.floor(Math.random() * (capped + 1));

                break;
            }

        }

        return Math.min(this._max, Math.max(0, Math.floor(delay)));

    }

}
