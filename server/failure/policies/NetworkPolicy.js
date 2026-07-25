/**
 * R7.0F — Domain policy: network / HTTP.
 */

import { BACKOFF_STRATEGY, FAILURE_COMPONENT } from "../failureTypes.js";

export const NetworkPolicy = Object.freeze({
    name: FAILURE_COMPONENT.NETWORK,
    allowRetry: true,
    useCircuitBreaker: true,
    circuitName: "network",
    backoffStrategy: BACKOFF_STRATEGY.EXPONENTIAL,
    maxAttempts: null
});
