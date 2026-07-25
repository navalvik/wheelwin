/**
 * R7.0F — Domain policy: gameplay (no retries / no circuit).
 */

import { BACKOFF_STRATEGY, FAILURE_COMPONENT } from "../failureTypes.js";

export const GameplayPolicy = Object.freeze({
    name: FAILURE_COMPONENT.GAMEPLAY,
    allowRetry: false,
    useCircuitBreaker: false,
    backoffStrategy: BACKOFF_STRATEGY.FIXED,
    maxAttempts: 1
});
