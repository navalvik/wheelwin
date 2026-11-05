import {
    bindAuthoritativeSessionStore,
    isServerAuthoritative
} from "./gameAuthority.js";

import {
    AUTHORITATIVE_SESSION_ACTIONS,
    createAuthoritativeSessionStore
} from "./session/authoritativeSessionModel.js";
import { listAuthoritativePlayers } from "./session/authoritativePlayerView.js";
import { formatAuthoritativeRoomPlayersDisplay } from "./session/authoritativeRoomView.js";

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


{

    // Telegram/WebView refresh can miss the original GAME_START event.
    // Recovering the same server-authenticated room and game must still
    // establish apply-only physics authority before SPEED/BRAKE rendering.
    const store = createAuthoritativeSessionStore();
    bindAuthoritativeSessionStore(store);
    const id = { roomId: "reclaim-room", gameId: "reclaim-game" };

    assert(!isServerAuthoritative(), "fresh WebView has no game ownership");

    store.dispatch({
        type: AUTHORITATIVE_SESSION_ACTIONS.GAME_START_AUTHORIZED,
        payload: id
    });
    assert(isServerAuthoritative(), "replayed start authorization restores server authority");

    store.dispatch({
        type: AUTHORITATIVE_SESSION_ACTIONS.GAME_INITIALIZING,
        payload: id
    });
    assert(isServerAuthoritative(), "initializing retains server ownership");

    store.dispatch({
        type: AUTHORITATIVE_SESSION_ACTIONS.GAME_END,
        payload: { gameId: id.gameId }
    });
    assert(!isServerAuthoritative(), "terminal cleanup releases server ownership");

    store.dispatch({
        type: AUTHORITATIVE_SESSION_ACTIONS.GAME_START_AUTHORIZED,
        payload: id
    });
    assert(!isServerAuthoritative(), "delayed authorization cannot reopen a completed game");
    bindAuthoritativeSessionStore(null);

    const recovering = createAuthoritativeSessionStore();
    bindAuthoritativeSessionStore(recovering);
    recovering.dispatch({
        type: AUTHORITATIVE_SESSION_ACTIONS.SESSION_SNAPSHOT,
        payload: {
            ...id,
            gameState: "SPEED"
        }
    });
    assert(isServerAuthoritative(), "recovered live SPEED snapshot restores server authority");
    recovering.dispatch({
        type: AUTHORITATIVE_SESSION_ACTIONS.GAME_START_AUTHORIZED,
        payload: { roomId: "foreign-room", gameId: "foreign-game" }
    });
    assert(recovering.getSnapshot().roomId === id.roomId,
        "foreign room may not claim an active game");
    recovering.dispatch({
        type: AUTHORITATIVE_SESSION_ACTIONS.GAME_INITIALIZING,
        payload: { roomId: id.roomId, gameId: "foreign-game" }
    });
    assert(recovering.getSnapshot().gameId === id.gameId,
        "foreign game may not replace the recovered game");
    bindAuthoritativeSessionStore(null);
    console.log("  recovered Telegram authority passed");

}

{

    const rosterStore = createAuthoritativeSessionStore();
    const players = ["olga", "bob", "lena"].map((playerId) => ({
        playerId,
        name: playerId
    }));

    rosterStore.dispatch({
        type: AUTHORITATIVE_SESSION_ACTIONS.GAME_START,
        payload: {
            roomId: "3VHh",
            gameId: "current-game",
            maxPlayers: 3,
            players
        }
    });

    rosterStore.dispatch({
        type: AUTHORITATIVE_SESSION_ACTIONS.SESSION_SNAPSHOT,
        payload: {
            roomId: "previous-room",
            gameId: "previous-game",
            gameState: "SPEED",
            playerStates: ["old-a", "old-b", "old-c"].map((playerId) => ({
                playerId,
                name: playerId
            }))
        }
    });

    assert(Object.keys(rosterStore.getSnapshot().players).length === 3,
        "foreign snapshot must not append stale players to the active roster");
    assert(players.every((player) =>
        rosterStore.getSnapshot().players[player.playerId]?.playerId
            === player.playerId),
    "foreign snapshot must preserve the active room player identities");
    assert(listAuthoritativePlayers(rosterStore.getSnapshot().players).length === 3,
        "Page4 and Page5 shared player view must contain exactly three cards");
    assert(formatAuthoritativeRoomPlayersDisplay(
        rosterStore.getSnapshot().players,
        3,
        3
    ) === "3 / 3", "InfoBar must show the three-player room capacity");

    rosterStore.dispatch({
        type: AUTHORITATIVE_SESSION_ACTIONS.SESSION_SNAPSHOT,
        payload: {
            roomId: "3VHh",
            gameId: "current-game",
            gameState: "SPEED",
            playerStates: players.map((player) => ({
                ...player,
                online: true
            }))
        }
    });
    assert(listAuthoritativePlayers(rosterStore.getSnapshot().players).length === 3,
        "matching recovery snapshot must preserve exactly three active players");
    console.log("  foreign recovery snapshot roster isolation passed");

}

console.log("gameAuthority.test.js: all assertions passed");
