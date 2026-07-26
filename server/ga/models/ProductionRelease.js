/**
 * R9.0A — Immutable production release record.
 */

/**
 * @param {{
 *   version?: string|null,
 *   channel?: string|null,
 *   commit?: string|null,
 *   fingerprint?: string|null,
 *   certificationRef?: string|null,
 *   verificationRef?: string|null,
 *   startedAt?: number|null,
 *   completedAt?: number|null,
 *   announcedAt?: number|null
 * }} input
 */
export function createProductionRelease(input = {}) {

    return Object.freeze({
        version: input.version ? String(input.version).slice(0, 64) : null,
        channel: input.channel ? String(input.channel).slice(0, 32) : "production",
        commit: input.commit ? String(input.commit).slice(0, 64) : null,
        fingerprint: input.fingerprint
            ? String(input.fingerprint).slice(0, 128)
            : null,
        certificationRef: input.certificationRef
            ? String(input.certificationRef).slice(0, 128)
            : null,
        verificationRef: input.verificationRef
            ? String(input.verificationRef).slice(0, 128)
            : null,
        startedAt: Number.isFinite(input.startedAt) ? input.startedAt : null,
        completedAt: Number.isFinite(input.completedAt)
            ? input.completedAt
            : null,
        announcedAt: Number.isFinite(input.announcedAt)
            ? input.announcedAt
            : null
    });

}

/**
 * @param {ReturnType<typeof createProductionRelease>} release
 * @param {object} patch
 */
export function withProductionReleasePatch(release, patch) {

    return createProductionRelease({
        ...release,
        ...patch
    });

}
