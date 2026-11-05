/**
 * Phase 3 — Global Toncenter request rate limiter.
 *
 * One limiter instance is shared by every Toncenter request a service makes.
 * Dispatch spacing is configurable and derived from `requestsPerSecond`
 * (default 8 requests/second — the conservative authenticated default below
 * the documented Free-plan ceiling of 10 requests/second). It is NOT a
 * hardcoded 1-request-per-second limit.
 *
 * The limiter guarantees that no more than `requestsPerSecond` requests are
 * dispatched inside any rolling one-second window, so the documented
 * account-level quota is respected.
 *
 * `now` and `delay` are injectable so tests run on a virtual clock: no test
 * ever waits on real time and no test needs the live provider.
 */

import { PaymentConfigurationError } from "../PaymentErrors.js";

import {
    TONCENTER_DEFAULT_MAX_REQUESTS_PER_SECOND,
    TONCENTER_DOCUMENTED_FREE_PLAN_RPS
} from "./ToncenterConstants.js";

/** Production delay implementation. */
function defaultDelay(ms) {

    return new Promise((resolve) => {

        setTimeout(resolve, ms);

    });

}

/**
 * Validate an explicit rate configuration.
 *
 * Rules:
 *   - `requestsPerSecond` must be a positive safe integer;
 *   - a rate above the documented Free-plan ceiling is accepted ONLY when
 *     `subscriptionPlanVerified` is explicitly true. The current subscription
 *     tier is unverified, so exceeding 10 requests/second without that flag
 *     is a configuration error, never a silent default.
 *
 * @param {{ requestsPerSecond: number, subscriptionPlanVerified?: boolean }} options
 * @returns {void}
 */
export function assertToncenterRateConfiguration({
    requestsPerSecond,
    subscriptionPlanVerified = false
}) {

    if (!Number.isSafeInteger(requestsPerSecond) || requestsPerSecond <= 0) {

        throw new PaymentConfigurationError(
            "requestsPerSecond must be a positive safe integer",
            { requestsPerSecond }
        );

    }

    if (requestsPerSecond > TONCENTER_DOCUMENTED_FREE_PLAN_RPS
        && subscriptionPlanVerified !== true) {

        throw new PaymentConfigurationError(
            `requestsPerSecond=${requestsPerSecond} exceeds the documented`
                + ` Toncenter Free-plan ceiling of`
                + ` ${TONCENTER_DOCUMENTED_FREE_PLAN_RPS} requests/second, and`
                + ` the subscription tier has not been verified. Use`
                + ` ${TONCENTER_DEFAULT_MAX_REQUESTS_PER_SECOND} requests/second`
                + ` or explicitly configure a rate matching the verified plan`,
            {
                requestsPerSecond,
                documentedFreePlanCeiling: TONCENTER_DOCUMENTED_FREE_PLAN_RPS,
                defaultRate: TONCENTER_DEFAULT_MAX_REQUESTS_PER_SECOND,
                subscriptionPlanVerified: false
            }
        );

    }

}

export class ToncenterRateLimiter {

    /**
     * @param {{
     *   requestsPerSecond?: number,
     *   subscriptionPlanVerified?: boolean,
     *   now?: () => number,
     *   delay?: (ms: number) => Promise<void>
     * }} [options]
     */
    constructor({
        requestsPerSecond = TONCENTER_DEFAULT_MAX_REQUESTS_PER_SECOND,
        subscriptionPlanVerified = false,
        now = Date.now,
        delay = defaultDelay
    } = {}) {

        assertToncenterRateConfiguration({
            requestsPerSecond,
            subscriptionPlanVerified
        });

        if (typeof now !== "function" || typeof delay !== "function") {

            throw new PaymentConfigurationError(
                "now and delay must be functions"
            );

        }

        this._requestsPerSecond = requestsPerSecond;

        this._subscriptionPlanVerified = subscriptionPlanVerified === true;

        this._now = now;

        this._delay = delay;

        /** Minimum spacing between dispatches, in milliseconds. */
        this._intervalMs = 1000 / requestsPerSecond;

        this._lastDispatchAt = null;

        this._chain = Promise.resolve();

    }

    /** Configured maximum request rate (requests/second). */
    get requestsPerSecond() {

        return this._requestsPerSecond;

    }

    /**
     * Reserve one dispatch slot. The returned promise resolves when a request
     * may be issued. Acquires are served strictly in call order.
     *
     * @returns {Promise<void>}
     */
    acquire() {

        const run = async () => {

            if (this._lastDispatchAt === null) {

                this._lastDispatchAt = this._now();

                return;

            }

            const earliest = this._lastDispatchAt + this._intervalMs;

            const waitMs = Math.max(0, earliest - this._now());

            if (waitMs > 0) {

                await this._delay(waitMs);

            }

            this._lastDispatchAt = this._now();

        };

        this._chain = this._chain.then(run, run);

        return this._chain;

    }

    /**
     * Public rate-limit policy descriptor (transparency for operators).
     *
     * @returns {Readonly<object>}
     */
    policy() {

        return Object.freeze({
            requestsPerSecond: this._requestsPerSecond,
            dispatchIntervalMs: this._intervalMs,
            defaultRate: TONCENTER_DEFAULT_MAX_REQUESTS_PER_SECOND,
            documentedFreePlanCeiling: TONCENTER_DOCUMENTED_FREE_PLAN_RPS,
            subscriptionPlanVerified: this._subscriptionPlanVerified
        });

    }

}
