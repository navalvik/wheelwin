import {
    bindAuthoritativeSessionStore,
    isServerAuthoritative
} from "./gameAuthority.js";

import {
    AUTHORITATIVE_SESSION_ACTIONS,
    createAuthoritativeSessionStore
} from "./session/authoritativeSessionModel.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

{

    bindAuthoritativeSessionStore(null);

    assert(
        isServerAuthoritative() === false,
        "no session store → not authoritative"
    );

    console.log("  unbound store passed");

}

{

    const store = createAuthoritativeSessionStore();

    bindAuthoritativeSessionStore(store);

    assert(
        isServerAuthoritative() === false,
        "before GAME_START → not authoritative"
    );

    store.dispatch({
        type: AUTHORITATIVE_SESSION_ACTIONS.GAME_START,
        payload: {
            roomId: "ROOM1",
            gameId: "g1",
            players: []
        }
    });

    assert(
        isServerAuthoritative() === true,
        "after GAME_START → authoritative"
    );

    // Disconnect must not clear authority (no socket involved).
    assert(
        isServerAuthoritative() === true,
        "authority independent of transport"
    );

    store.dispatch({
        type: AUTHORITATIVE_SESSION_ACTIONS.GAME_END,
        payload: { gameId: "g1" }
    });

    assert(
        isServerAuthoritative() === false,
        "after cleanup (GAME_END) → not authoritative"
    );

    store.reset();

    assert(
        isServerAuthoritative() === false,
        "after session reset → not authoritative"
    );

    bindAuthoritativeSessionStore(null);

    console.log("  lifecycle authority passed");

}

{

    const store = createAuthoritativeSessionStore();

    bindAuthoritativeSessionStore(store);

    store.dispatch({
        type: AUTHORITATIVE_SESSION_ACTIONS.GAME_START,
        payload: { roomId: "R2", gameId: "g2", players: [] }
    });

    assert(isServerAuthoritative() === true, "session active");

    // Rebind same store (reconnect-style) must not destroy authority.
    bindAuthoritativeSessionStore(store);

    assert(
        isServerAuthoritative() === true,
        "rebind / reconnect must not clear authority"
    );

    bindAuthoritativeSessionStore(null);

    console.log("  reconnect authority preserve passed");

}

console.log("gameAuthority.test.js: all assertions passed");
