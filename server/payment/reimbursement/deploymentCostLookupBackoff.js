/**
 * R17.8V.2P.L — Lookup retry backoff for deployment cost snapshots.
 */

/** Attempt index 1-based → delay ms before nextLookupAt. */
const BACKOFF_MS = Object.freeze([
    5_000,
    30_000,
    5 * 60_000,
    15 * 60_000,
    30 * 60_000,
    60 * 60_000
]);

export const DEPLOYMENT_COST_LOOKUP_MAX_ATTEMPTS = 12;

/** Pending older than this is treated as stuck (log + force eligible). */
export const DEPLOYMENT_COST_STUCK_THRESHOLD_MS = 15 * 60_000;

/**
 * @param {number} attemptCount after increment (1-based)
 * @returns {number} delay ms
 */
export function deploymentCostLookupBackoffMs(attemptCount) {

    const index = Math.max(1, Number(attemptCount) || 1) - 1;

    if (index < BACKOFF_MS.length) {

        return BACKOFF_MS[index];

    }

    return BACKOFF_MS[BACKOFF_MS.length - 1];

}

/**
 * @param {number} attemptCount
 * @param {number} [now]
 * @returns {number}
 */
export function deploymentCostNextLookupAt(attemptCount, now = Date.now()) {

    return now + deploymentCostLookupBackoffMs(attemptCount);

}

/**
 * @param {object|null|undefined} payload
 * @param {number} [now]
 * @returns {boolean}
 */
export function isDeploymentCostLookupDue(payload, now = Date.now()) {

    if (!payload || typeof payload !== "object") {

        return false;

    }

    const status = payload.status;

    if (
        status !== "PENDING_LOOKUP"
        && status !== "FAILED_LOOKUP"
    ) {

        return false;

    }

    const next = payload.nextLookupAt;

    if (next == null || next === "") {

        return true;

    }

    const nextAt = Number(next);

    if (!Number.isFinite(nextAt)) {

        return true;

    }

    return nextAt <= now;

}

/**
 * @param {object|null|undefined} payload
 * @param {number} [now]
 * @param {number} [thresholdMs]
 * @returns {boolean}
 */
export function isDeploymentCostSnapshotStuck(
    payload,
    now = Date.now(),
    thresholdMs = DEPLOYMENT_COST_STUCK_THRESHOLD_MS
) {

    if (!payload || payload.status !== "PENDING_LOOKUP") {

        return false;

    }

    const createdAt = Number(payload.createdAt);

    if (!Number.isFinite(createdAt)) {

        return false;

    }

    return createdAt + thresholdMs < now;

}
