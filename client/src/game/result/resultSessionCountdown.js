/**
 * R12.5A — Display helpers for the authoritative Page6 Result Session lifetime.
 * Observes expiresAt only; never owns terminal navigation.
 */

/**
 * Whole seconds remaining until the Result Session deadline.
 * Uses ceil so the final "1" remains visible until the deadline crosses.
 */
export function remainingResultSessionSeconds(expiresAt, now = Date.now()) {

    if (!Number.isFinite(expiresAt)) {

        return null;

    }

    return Math.max(0, Math.ceil((expiresAt - now) / 1000));

}

/**
 * Extract the authoritative Result Session expiresAt from OPEN_PAGE6 payload
 * or a recovery snapshot. Does not invent a duration.
 */
export function resolveResultSessionExpiresAt(source) {

    if (!source || typeof source !== "object") {

        return null;

    }

    const expiresAt = source.expiresAt ?? source.resultSessionExpiresAt;

    return Number.isFinite(expiresAt) ? expiresAt : null;

}
