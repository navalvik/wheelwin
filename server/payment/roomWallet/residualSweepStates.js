/**
 * Room-level residual sweep lifecycle statuses.
 *
 * Broadcast is not confirmation. CONFIRMED is the only completed transfer.
 */

export const RESIDUAL_SWEEP_STATUS = Object.freeze({
    PENDING: "PENDING",
    PROCESSING: "PROCESSING",
    AWAITING_TRANSACTION_HASH: "AWAITING_TRANSACTION_HASH",
    CONFIRMED: "CONFIRMED",
    FAILED_RETRY: "FAILED_RETRY",
    FAILED_TERMINAL: "FAILED_TERMINAL"
});

export const RESIDUAL_SWEEP_STATUSES = Object.freeze(
    Object.values(RESIDUAL_SWEEP_STATUS)
);

export function isResidualSweepStatus(status) {
    return RESIDUAL_SWEEP_STATUSES.includes(status);
}

export function isResidualSweepTerminal(status) {
    return status === RESIDUAL_SWEEP_STATUS.CONFIRMED
        || status === RESIDUAL_SWEEP_STATUS.FAILED_TERMINAL;
}

export function isResidualSweepInFlight(status) {
    return status === RESIDUAL_SWEEP_STATUS.PENDING
        || status === RESIDUAL_SWEEP_STATUS.PROCESSING
        || status === RESIDUAL_SWEEP_STATUS.AWAITING_TRANSACTION_HASH
        || status === RESIDUAL_SWEEP_STATUS.FAILED_RETRY;
}
