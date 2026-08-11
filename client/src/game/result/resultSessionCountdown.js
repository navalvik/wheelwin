/**
 * R12.5A / R12.5I — Result Session deadline helpers.
 *
 * Stores/observes the authoritative server expiresAt for recovery and
 * diagnostics. Does not drive Page6 UI countdown or client navigation
 * (FINISH owns Page6 → Page1 after R12.5H).
 */

/**
 * Whole seconds remaining until the Result Session deadline.
 * Used for diagnostics / observability only after R12.5H.
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
