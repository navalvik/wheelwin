/**
 * R17.8F — RoomLobby / RecoveryExperience reconnect policy helpers.
 *
 * Separates transport reconnect (socket back) from session recovery
 * (authoritative reclaim). Pure functions for node tests — no React.
 */

import {
    hasGameplayIdentity,
    isGameplayPage,
    isSetupRecoveryPage
} from "./recoveryFlow.js";

/**
 * Max time the recovery overlay may stay on RECONNECTING.
 * Aligned with OVERLAY_MAX_VISIBLE_MS (5s) × 3 — long enough for Socket.IO
 * backoff (delayMax 5s) without blocking the lobby forever.
 * Does not wipe identity or session data.
 */
export const RECONNECTING_MAX_MS = 15_000;

export const RECONNECT_CONNECT_ACTIONS = Object.freeze({
    NOOP: "NOOP",
    /** Socket restored; no room/player claim — clear overlay only. */
    CLEAR_TRANSPORT_ONLY: "CLEAR_TRANSPORT_ONLY",
    /** Identity present — run existing SESSION_RECOVERY_REQUEST flow. */
    REQUEST_SESSION_RECOVERY: "REQUEST_SESSION_RECOVERY"
});

/**
 * Decide what to do after Socket.IO fires `connect` following a disconnect
 * on a recovery-capable surface (lobby / prep / gameplay).
 */
export function resolvePostReconnectAction({
    hadDisconnect = false,
    currentPage = null,
    identity = null
} = {}) {

    if (!hadDisconnect) {

        return RECONNECT_CONNECT_ACTIONS.NOOP;

    }

    const onRecoverySurface = isSetupRecoveryPage(currentPage)
        || isGameplayPage(currentPage);

    if (!onRecoverySurface) {

        return RECONNECT_CONNECT_ACTIONS.NOOP;

    }

    if (!hasGameplayIdentity(identity)) {

        return RECONNECT_CONNECT_ACTIONS.CLEAR_TRANSPORT_ONLY;

    }

    return RECONNECT_CONNECT_ACTIONS.REQUEST_SESSION_RECOVERY;

}

/**
 * R17.8F — Stale in-flight flags from a lost recovery response must not block
 * the next reconnect lifecycle. Duplicate protection still applies after a
 * fresh REQUEST_SESSION_RECOVERY sets inFlight again.
 */
export function shouldResetRecoveryInFlight(action) {

    return action === RECONNECT_CONNECT_ACTIONS.CLEAR_TRANSPORT_ONLY
        || action === RECONNECT_CONNECT_ACTIONS.REQUEST_SESSION_RECOVERY;

}
