/**
 * C5.9A — Server Authority ownership.
 *
 * Authority follows the AuthoritativeSession lifecycle, not transport.
 * Socket disconnect must never hand gameplay ownership to the client.
 */

let authoritativeSessionStore = null;

/**
 * Bind the live AuthoritativeSession store so non-React callers
 * (PhysicsContext, WinnerResolverContext, GameStateContext) can read
 * the same lifecycle the UI mirrors. Does not invent a parallel model.
 */
export function bindAuthoritativeSessionStore(store) {

    authoritativeSessionStore = store ?? null;

}

/**
 * True once the authoritative game session has started (GAME_START /
 * post–GAME_INITIALIZED on the server) and until server cleanup is
 * observed. Independent of socket.connected.
 */
export function isServerAuthoritative() {

    const state = authoritativeSessionStore?.getSnapshot?.() ?? null;

    const lifecycle = state?.lifecycle;

    if (!lifecycle) {

        return false;

    }

    return lifecycle.gameStarted === true
        && lifecycle.cleanupObserved !== true;

}
