/**
 * R17.8V.2P.H — Deployment cost snapshot lifecycle statuses.
 *
 * Stage A: constants only. Transitions / blockchain freeze arrive in later stages.
 */

export const DEPLOYMENT_COST_SNAPSHOT_STATUS = Object.freeze({
    PENDING_LOOKUP: "PENDING_LOOKUP",
    FROZEN: "FROZEN",
    FAILED_LOOKUP: "FAILED_LOOKUP"
});

export const DEPLOYMENT_COST_SNAPSHOT_STATUSES = Object.freeze(
    Object.values(DEPLOYMENT_COST_SNAPSHOT_STATUS)
);

/**
 * @param {unknown} status
 * @returns {boolean}
 */
export function isDeploymentCostSnapshotStatus(status) {

    return DEPLOYMENT_COST_SNAPSHOT_STATUSES.includes(status);

}

/**
 * @param {unknown} status
 * @returns {boolean}
 */
export function isDeploymentCostSnapshotFrozen(status) {

    return status === DEPLOYMENT_COST_SNAPSHOT_STATUS.FROZEN;

}
