/**
 * R7.0G — Probe type constants.
 */

export const PROBE_TYPE = Object.freeze({
    STARTUP: "startup",
    LIVENESS: "liveness",
    READINESS: "readiness",
    HEALTH: "health"
});

export const PROBE_STATUS = Object.freeze({
    PASS: "pass",
    FAIL: "fail",
    UNKNOWN: "unknown"
});
