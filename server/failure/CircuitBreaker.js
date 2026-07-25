/**
 * R7.0F — Circuit breaker for external dependencies (never for gameplay).
 */

import { CIRCUIT_STATE } from "./failureTypes.js";

export class CircuitBreaker {

    /**
     * @param {{
     *   name: string,
     *   failureThreshold?: number,
     *   recoveryTimeoutMs?: number,
     *   successThreshold?: number
     * }} options
     */
    constructor({
        name,
        failureThreshold = 5,
        recoveryTimeoutMs = 30_000,
        successThreshold = 2
    }) {

        this.name = name;

        this._failureThreshold = Math.max(1, failureThreshold);

        this._recoveryTimeoutMs = Math.max(1, recoveryTimeoutMs);

        this._successThreshold = Math.max(1, successThreshold);

        this._state = CIRCUIT_STATE.CLOSED;

        this._failures = 0;

        this._successes = 0;

        this._openedAt = null;

        this._openCount = 0;

        this._recoveryCount = 0;

    }

    get state() {

        this._maybeHalfOpen();

        return this._state;

    }

    /**
     * @returns {boolean} true if call is allowed
     */
    allowRequest() {

        this._maybeHalfOpen();

        return this._state !== CIRCUIT_STATE.OPEN;

    }

    recordSuccess() {

        this._maybeHalfOpen();

        if (this._state === CIRCUIT_STATE.HALF_OPEN) {

            this._successes += 1;

            if (this._successes >= this._successThreshold) {

                this._state = CIRCUIT_STATE.CLOSED;

                this._failures = 0;

                this._successes = 0;

                this._openedAt = null;

                this._recoveryCount += 1;

            }

            return;

        }

        this._failures = 0;

    }

    recordFailure() {

        this._maybeHalfOpen();

        if (this._state === CIRCUIT_STATE.HALF_OPEN) {

            this._trip();

            return;

        }

        this._failures += 1;

        if (this._failures >= this._failureThreshold) {

            this._trip();

        }

    }

    getStatus() {

        return {
            name: this.name,
            state: this.state,
            failures: this._failures,
            successes: this._successes,
            openCount: this._openCount,
            recoveryCount: this._recoveryCount,
            openedAt: this._openedAt
        };

    }

    _trip() {

        this._state = CIRCUIT_STATE.OPEN;

        this._openedAt = Date.now();

        this._successes = 0;

        this._openCount += 1;

    }

    _maybeHalfOpen() {

        if (this._state === CIRCUIT_STATE.OPEN
            && this._openedAt != null
            && Date.now() - this._openedAt >= this._recoveryTimeoutMs) {

            this._state = CIRCUIT_STATE.HALF_OPEN;

            this._successes = 0;

        }

    }

}
