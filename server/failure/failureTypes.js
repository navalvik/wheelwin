/**
 * R7.0F — Failure categories and decision outcomes.
 */

export const FAILURE_CATEGORY = Object.freeze({
    RECOVERABLE: "RECOVERABLE",
    TRANSIENT: "TRANSIENT",
    RATE_LIMITED: "RATE_LIMITED",
    NON_RECOVERABLE: "NON_RECOVERABLE",
    FATAL: "FATAL"
});

export const FAILURE_DECISION = Object.freeze({
    RETRY_NOW: "RETRY_NOW",
    RETRY_LATER: "RETRY_LATER",
    IGNORE: "IGNORE",
    ESCALATE: "ESCALATE",
    FAIL: "FAIL",
    SHUTDOWN: "SHUTDOWN"
});

export const BACKOFF_STRATEGY = Object.freeze({
    FIXED: "fixed",
    LINEAR: "linear",
    EXPONENTIAL: "exponential",
    EXPONENTIAL_JITTER: "exponential_jitter"
});

export const CIRCUIT_STATE = Object.freeze({
    CLOSED: "CLOSED",
    OPEN: "OPEN",
    HALF_OPEN: "HALF_OPEN"
});

export const FAILURE_COMPONENT = Object.freeze({
    GAMEPLAY: "gameplay",
    PAYMENT: "payment",
    BLOCKCHAIN: "blockchain",
    NETWORK: "network",
    STORAGE: "storage",
    CONFIGURATION: "configuration",
    SYSTEM: "system"
});
