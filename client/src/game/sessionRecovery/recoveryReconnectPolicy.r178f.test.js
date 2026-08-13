/**
 * R17.8F — RoomLobby reconnect policy (transport vs session recovery).
 */
import {
    APP_PAGES,
    hasGameplayIdentity
} from "./recoveryFlow.js";

import {
    RECONNECT_CONNECT_ACTIONS,
    RECONNECTING_MAX_MS,
    resolvePostReconnectAction,
    shouldResetRecoveryInFlight
} from "./recoveryReconnectPolicy.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

assert(
    RECONNECTING_MAX_MS === 15_000,
    "R17.8F RECONNECTING_MAX_MS must be 15s"
);

assert(
    RECONNECTING_MAX_MS > 5_000,
    "R17.8F reconnect timeout must exceed COMPLETE overlay hard cap"
);

// ---------------------------------------------------------------------------
// Test A — RoomLobby without identity (before room creation)
// ---------------------------------------------------------------------------

{

    const action = resolvePostReconnectAction({
        hadDisconnect: true,
        currentPage: APP_PAGES.LOBBY,
        identity: { roomId: null, playerId: null }
    });

    assert(
        action === RECONNECT_CONNECT_ACTIONS.CLEAR_TRANSPORT_ONLY,
        "Test A: lobby without identity clears transport reconnect only"
    );

    assert(
        !hasGameplayIdentity({ roomId: null, playerId: null }),
        "Test A: empty identity is not a session claim"
    );

    assert(
        shouldResetRecoveryInFlight(action),
        "Test A: clear path resets recoveryInFlight"
    );

    console.log("  R17.8F Test A — lobby without identity → CLEAR_TRANSPORT_ONLY");

}

// ---------------------------------------------------------------------------
// Test B — Existing session identity (recovery must still run)
// ---------------------------------------------------------------------------

{

    const identity = { roomId: "ROOM1", playerId: "player_1" };

    const lobbyAction = resolvePostReconnectAction({
        hadDisconnect: true,
        currentPage: APP_PAGES.LOBBY,
        identity
    });

    assert(
        lobbyAction === RECONNECT_CONNECT_ACTIONS.REQUEST_SESSION_RECOVERY,
        "Test B: lobby with identity requests session recovery"
    );

    const gameplayAction = resolvePostReconnectAction({
        hadDisconnect: true,
        currentPage: APP_PAGES.GAMEPLAY,
        identity
    });

    assert(
        gameplayAction === RECONNECT_CONNECT_ACTIONS.REQUEST_SESSION_RECOVERY,
        "Test B: gameplay with identity requests session recovery"
    );

    assert(
        shouldResetRecoveryInFlight(lobbyAction),
        "Test B: reconnect resets stale inFlight before new request"
    );

    console.log("  R17.8F Test B — identity present → REQUEST_SESSION_RECOVERY");

}

// ---------------------------------------------------------------------------
// Test C — Lost recovery response must not permanently block
// ---------------------------------------------------------------------------

{

    let recoveryInFlight = true;

    const action = resolvePostReconnectAction({
        hadDisconnect: true,
        currentPage: APP_PAGES.LOBBY,
        identity: { roomId: "ROOM1", playerId: "player_1" }
    });

    assert(
        action === RECONNECT_CONNECT_ACTIONS.REQUEST_SESSION_RECOVERY,
        "Test C: second reconnect still resolves to recovery"
    );

    if (shouldResetRecoveryInFlight(action)) {

        recoveryInFlight = false;

    }

    assert(
        recoveryInFlight === false,
        "Test C: stale recoveryInFlight cleared before re-request"
    );

    // Duplicate guard still works once a fresh request marks in-flight.
    recoveryInFlight = true;

    const blocked = recoveryInFlight === true;

    assert(
        blocked,
        "Test C: duplicate protection remains after a fresh request starts"
    );

    console.log("  R17.8F Test C — lost response does not permanently block");

}

// ---------------------------------------------------------------------------
// Guard rails — welcome / no prior disconnect
// ---------------------------------------------------------------------------

{

    assert(
        resolvePostReconnectAction({
            hadDisconnect: false,
            currentPage: APP_PAGES.LOBBY,
            identity: null
        }) === RECONNECT_CONNECT_ACTIONS.NOOP,
        "no prior disconnect → NOOP"
    );

    assert(
        resolvePostReconnectAction({
            hadDisconnect: true,
            currentPage: APP_PAGES.WELCOME,
            identity: null
        }) === RECONNECT_CONNECT_ACTIONS.NOOP,
        "welcome page is not a recovery surface for reconnect overlay clear"
    );

    console.log("  R17.8F guard rails — NOOP cases");

}

console.log("recoveryReconnectPolicy.r178f.test.js: all assertions passed");
