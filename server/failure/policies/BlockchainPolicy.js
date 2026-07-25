/**
 * R7.0F — Domain policy: blockchain / TON.
 */

import { BACKOFF_STRATEGY, FAILURE_COMPONENT } from "../failureTypes.js";

export const BlockchainPolicy = Object.freeze({
    name: FAILURE_COMPONENT.BLOCKCHAIN,
    allowRetry: true,
    useCircuitBreaker: true,
    circuitName: "blockchain",
    backoffStrategy: BACKOFF_STRATEGY.EXPONENTIAL_JITTER,
    maxAttempts: null
});
