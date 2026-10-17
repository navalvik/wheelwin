/**
 * R7.0F — Domain policy: payment (financial, no auto-retry / no circuit).
 */

import { BACKOFF_STRATEGY, FAILURE_COMPONENT } from "../failureTypes.js";

export const PaymentPolicy = Object.freeze({
    name: FAILURE_COMPONENT.PAYMENT,
    allowRetry: false,
    useCircuitBreaker: false,
    backoffStrategy: BACKOFF_STRATEGY.FIXED,
    maxAttempts: 1
});
