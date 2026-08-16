/**
 * R17.8V.2P.M — Deployment reimbursement lifecycle statuses.
 *
 * Stage M: queue states only. No status implies on-chain payment success.
 */

export const DEPLOYMENT_REIMBURSEMENT_STATUS = Object.freeze({
    PENDING: "PENDING",
    PROCESSING: "PROCESSING",
    AWAITING_TRANSACTION_HASH: "AWAITING_TRANSACTION_HASH",
    CONFIRMED: "CONFIRMED",
    FAILED_RETRY: "FAILED_RETRY",
    FAILED_TERMINAL: "FAILED_TERMINAL",
    CANCELLED: "CANCELLED"
});

export const DEPLOYMENT_REIMBURSEMENT_STATUSES = Object.freeze(
    Object.values(DEPLOYMENT_REIMBURSEMENT_STATUS)
);

/**
 * @param {unknown} status
 * @returns {boolean}
 */
export function isDeploymentReimbursementStatus(status) {

    return DEPLOYMENT_REIMBURSEMENT_STATUSES.includes(status);

}

/**
 * @param {unknown} status
 * @returns {boolean}
 */
export function isDeploymentReimbursementTerminal(status) {

    return status === DEPLOYMENT_REIMBURSEMENT_STATUS.CONFIRMED
        || status === DEPLOYMENT_REIMBURSEMENT_STATUS.CANCELLED
        || status === DEPLOYMENT_REIMBURSEMENT_STATUS.FAILED_TERMINAL;

}
