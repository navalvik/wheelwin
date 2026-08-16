/**
 * R17.8V.2P.P — Confirmation retry backoff for deployment reimbursement.
 */

const BACKOFF_MS = Object.freeze([
    5_000,
    15_000,
    30_000,
    60_000,
    5 * 60_000,
    15 * 60_000,
    30 * 60_000
]);

export const REIMBURSEMENT_CONFIRMATION_MAX_ATTEMPTS = 12;

/**
 * @param {number} attemptCount 1-based after increment
 * @returns {number}
 */
export function reimbursementConfirmationBackoffMs(attemptCount) {

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
export function reimbursementNextConfirmationAt(attemptCount, now = Date.now()) {

    return now + reimbursementConfirmationBackoffMs(attemptCount);

}

/**
 * @param {object|null|undefined} payload
 * @param {number} [now]
 * @returns {boolean}
 */
export function isReimbursementConfirmationDue(payload, now = Date.now()) {

    if (!payload || typeof payload !== "object") {

        return false;

    }

    if (payload.status !== "PROCESSING") {

        return false;

    }

    if (!String(payload.txHash ?? "").trim()) {

        return false;

    }

    const next = payload.nextConfirmationAt;

    if (next == null || next === "") {

        return true;

    }

    const nextAt = Number(next);

    if (!Number.isFinite(nextAt)) {

        return true;

    }

    return nextAt <= now;

}
