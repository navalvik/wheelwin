/**
 * R9.0B — Service version record.
 */

import { VERSION_SUPPORT_STATUS } from "../OperationsConfiguration.js";

/**
 * @param {{
 *   version?: string,
 *   releaseTimestamp?: number|null,
 *   gaTimestamp?: number|null,
 *   supportStatus?: string,
 *   retirementStatus?: boolean,
 *   notes?: string|null
 * }} input
 */
export function createServiceVersion(input = {}) {

    const key = String(
        input.supportStatus || VERSION_SUPPORT_STATUS.ACTIVE
    ).toUpperCase();

    const supportStatus = VERSION_SUPPORT_STATUS[key]
        ?? VERSION_SUPPORT_STATUS.ACTIVE;

    return Object.freeze({
        version: String(input.version || "unknown").slice(0, 64),
        releaseTimestamp: Number.isFinite(input.releaseTimestamp)
            ? input.releaseTimestamp
            : null,
        gaTimestamp: Number.isFinite(input.gaTimestamp)
            ? input.gaTimestamp
            : null,
        supportStatus,
        retirementStatus: input.retirementStatus === true
            || supportStatus === VERSION_SUPPORT_STATUS.RETIRED,
        notes: input.notes ? String(input.notes).slice(0, 256) : null
    });

}

/**
 * @param {ReturnType<typeof createServiceVersion>} version
 * @param {object} patch
 */
export function withServiceVersionPatch(version, patch) {

    return createServiceVersion({
        ...version,
        ...patch
    });

}
