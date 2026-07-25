/**
 * R7.0F — Domain policy: payments.
 */

import { BACKOFF_STRATEGY, FAILURE_COMPONENT } from "../failureTypes.js";

export const PaymentPolicy = Object.freeze({
    name: FAILURE_COMPONENT.PAYMENT,
    allowRetry: true,
    useCircuitBreaker: false,
    backoffStrategy: BACKOFF_STRATEGY.EXPONENTIAL,
    maxAttempts: null // use global default
});
