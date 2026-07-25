/**
 * R7.0F — Domain policy: storage (future).
 */

import { BACKOFF_STRATEGY, FAILURE_COMPONENT } from "../failureTypes.js";

export const StoragePolicy = Object.freeze({
    name: FAILURE_COMPONENT.STORAGE,
    allowRetry: true,
    useCircuitBreaker: true,
    circuitName: "storage",
    backoffStrategy: BACKOFF_STRATEGY.EXPONENTIAL_JITTER,
    maxAttempts: null
});
