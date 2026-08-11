/**
 * R12.5A / R12.5B — Display helpers for the authoritative Page6 Result Session
 * lifetime. Observes expiresAt only; never owns terminal navigation.
 */

/**
 * Whole seconds remaining until the Result Session deadline.
 * Uses ceil so the final second remains visible until the deadline crosses.
 */
export function remainingResultSessionSeconds(expiresAt, now = Date.now()) {

    if (!Number.isFinite(expiresAt)) {

        return null;

    }

    return Math.max(0, Math.ceil((expiresAt - now) / 1000));

}

/**
 * Format whole seconds as MM:SS for the Page6 InfoBar.
 */
export function formatResultSessionClock(remainingSeconds) {

    if (remainingSeconds === null || remainingSeconds === undefined) {

        return null;

    }

    const safeSeconds = Math.max(0, Math.floor(Number(remainingSeconds)));

    if (!Number.isFinite(safeSeconds)) {

        return null;

    }

    const minutes = Math.floor(safeSeconds / 60);

    const seconds = safeSeconds % 60;

    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;

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
