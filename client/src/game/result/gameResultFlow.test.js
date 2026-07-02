import {
    GAME_RESULT_ACTIONS,
    GAME_RESULT_INITIAL_STATE,
    GAME_RESULT_PAGE,
    gameResultReducer,
    mapAuthoritativeResultToView,
    shouldNavigateToResult,
    shouldResetResult
} from "./gameResultFlow.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

const AUTHORITATIVE_PAYLOAD = {
    gameId: "game_abc",
    winner: { id: "player_2", color: "#ff0000", icon: "🔥" },
    winningSector: {
        index: 3,
        sectorId: "sector_4",
        color: "#ff0000",
        icon: "🔥"
    },
    finalWheelAngle: 123.45,
    serverTimestamp: 1730000000000
};

// ---------------------------------------------------------------------------
// mapAuthoritativeResultToView — strict passthrough, no client calculation.
// ---------------------------------------------------------------------------

{

    const view = mapAuthoritativeResultToView(AUTHORITATIVE_PAYLOAD);

    assert(view.gameId === "game_abc", "gameId should pass through");

    assert(view.winner.id === "player_2", "winner id should match server payload");

    assert(view.winner.color === "#ff0000", "winner color should match payload");

    assert(view.winner.icon === "🔥", "winner icon should match payload");

    assert(
        view.winningSector.sectorId === "sector_4",
        "winning sector should match payload"
    );

    assert(view.winningSector.index === 3, "sector index should match payload");

    assert(
        view.finalWheelAngle === 123.45,
        "final wheel angle should pass through unchanged"
    );

    assert(
        view.serverTimestamp === 1730000000000,
        "server timestamp should pass through"
    );

    console.log("  map: authoritative passthrough passed");

}

// No client-side winner calculation: a payload that carries only physics data
// (an angle) but no authoritative winner must NOT produce a fabricated winner.
{

    const withoutWinner = mapAuthoritativeResultToView({
        gameId: "game_x",
        finalWheelAngle: 359.9,
        winningSector: { sectorId: "sector_1" }
    });

    assert(
        withoutWinner === null,
        "client must not fabricate a winner from angle/sector alone"
    );

    const empty = mapAuthoritativeResultToView(null);

    assert(empty === null, "null payload should map to null");

    console.log("  map: no client-side winner calculation passed");

}

// ---------------------------------------------------------------------------
// reducer — capture once, idempotent, navigation flag, reset.
// ---------------------------------------------------------------------------

{

    let state = { ...GAME_RESULT_INITIAL_STATE };

    state = gameResultReducer(state, {
        type: GAME_RESULT_ACTIONS.AUTHORITATIVE_RESULT,
        payload: AUTHORITATIVE_PAYLOAD
    });

    assert(state.result, "result should be captured");

    assert(state.result.winner.id === "player_2", "captured winner should match");

    // A second (repeated) GAME_RESULT must be ignored — no overwrite/reopen.
    const overwriteAttempt = gameResultReducer(state, {
        type: GAME_RESULT_ACTIONS.AUTHORITATIVE_RESULT,
        payload: {
            ...AUTHORITATIVE_PAYLOAD,
            winner: { id: "player_9", color: "#000", icon: "x" }
        }
    });

    assert(
        overwriteAttempt.result.winner.id === "player_2",
        "repeated GAME_RESULT must not overwrite the first authoritative result"
    );

    assert(
        overwriteAttempt === state,
        "repeated GAME_RESULT should return the same state reference"
    );

    console.log("  reducer: idempotent capture passed");

}

// ---------------------------------------------------------------------------
// Navigation — occurs exactly once, only from Page5, only with a result.
// ---------------------------------------------------------------------------

{

    let state = { ...GAME_RESULT_INITIAL_STATE };

    assert(
        !shouldNavigateToResult(state, GAME_RESULT_PAGE.PAGE5),
        "no navigation without a result"
    );

    state = gameResultReducer(state, {
        type: GAME_RESULT_ACTIONS.AUTHORITATIVE_RESULT,
        payload: AUTHORITATIVE_PAYLOAD
    });

    assert(
        !shouldNavigateToResult(state, 6),
        "navigation should only trigger from Page5"
    );

    assert(
        shouldNavigateToResult(state, GAME_RESULT_PAGE.PAGE5),
        "navigation should trigger once result exists on Page5"
    );

    state = gameResultReducer(state, { type: GAME_RESULT_ACTIONS.NAVIGATED });

    assert(
        !shouldNavigateToResult(state, GAME_RESULT_PAGE.PAGE5),
        "navigation must not trigger a second time"
    );

    // Even after arriving on Page6, repeated result messages do not re-navigate.
    const repeated = gameResultReducer(state, {
        type: GAME_RESULT_ACTIONS.AUTHORITATIVE_RESULT,
        payload: AUTHORITATIVE_PAYLOAD
    });

    assert(
        !shouldNavigateToResult(repeated, GAME_RESULT_PAGE.PAGE6),
        "repeated GAME_RESULT must not reopen Page6"
    );

    console.log("  navigation: occurs exactly once passed");

}

// ---------------------------------------------------------------------------
// Reset — a new game clears stale results on pre-gameplay pages.
// ---------------------------------------------------------------------------

{

    assert(shouldResetResult(1), "welcome page should reset stale result");

    assert(shouldResetResult(6), "pre-game pages should reset stale result");

    assert(
        !shouldResetResult(GAME_RESULT_PAGE.PAGE5),
        "Page5 should not reset the result"
    );

    assert(
        !shouldResetResult(GAME_RESULT_PAGE.PAGE6),
        "Page6 should not reset the result"
    );

    let state = gameResultReducer(
        { ...GAME_RESULT_INITIAL_STATE },
        {
            type: GAME_RESULT_ACTIONS.AUTHORITATIVE_RESULT,
            payload: AUTHORITATIVE_PAYLOAD
        }
    );

    state = gameResultReducer(state, { type: GAME_RESULT_ACTIONS.RESET });

    assert(state.result === null, "reset should clear the result");

    assert(state.navigated === false, "reset should clear the navigation flag");

    console.log("  reset: fresh game clears stale result passed");

}

console.log("gameResultFlow.test.js: all assertions passed");
