/**
 * R7.0B — Application process lifecycle states.
 *
 * STARTING → RUNNING → DRAINING → STOPPED
 */

export const APPLICATION_LIFECYCLE = Object.freeze({
    STARTING: "STARTING",
    RUNNING: "RUNNING",
    DRAINING: "DRAINING",
    STOPPED: "STOPPED"
});

export const DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_MS = 30_000;

export const DRAIN_POLL_INTERVAL_MS = 250;
