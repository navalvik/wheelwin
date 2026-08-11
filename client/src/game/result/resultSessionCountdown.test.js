/**
 * R12.5A — Page6 Result Session countdown (display-only).
 */
import assert from "node:assert/strict";

import {
    remainingResultSessionSeconds,
    resolveResultSessionExpiresAt
} from "./resultSessionCountdown.js";

import {
    GAME_RESULT_ACTIONS,
    GAME_RESULT_INITIAL_STATE,
    gameResultReducer
} from "./gameResultFlow.js";

{
    const now = 1_000_000;

    assert.equal(
        remainingResultSessionSeconds(now + 5000, now),
        5,
        "exact 5s remaining"
    );

    assert.equal(
        remainingResultSessionSeconds(now + 4501, now),
        5,
        "ceil keeps final visible second bands"
    );

    assert.equal(
        remainingResultSessionSeconds(now + 1, now),
        1,
        "1ms remaining still shows 1"
    );

    assert.equal(
        remainingResultSessionSeconds(now - 1, now),
        0,
        "never negative"
    );

    assert.equal(
        remainingResultSessionSeconds(null, now),
        null,
        "missing deadline is null"
    );

    console.log("  remainingResultSessionSeconds: OK");
}

{
    assert.equal(
        resolveResultSessionExpiresAt({ expiresAt: 12345 }),
        12345,
        "OPEN_PAGE6 expiresAt"
    );

    assert.equal(
        resolveResultSessionExpiresAt({ resultSessionExpiresAt: 99 }),
        99,
        "recovery snapshot field"
    );

    assert.equal(
        resolveResultSessionExpiresAt({}),
        null,
        "no invented duration"
    );

    console.log("  resolveResultSessionExpiresAt: OK");
}

{
    const deadline = Date.now() + 60_000;

    let state = gameResultReducer(
        { ...GAME_RESULT_INITIAL_STATE },
        {
            type: GAME_RESULT_ACTIONS.RESULT_SESSION,
            payload: { expiresAt: deadline }
        }
    );

    assert.equal(state.resultSessionExpiresAt, deadline, "stores deadline");

    // Remount/recovery with the same deadline must not restart lifetime.
    state = gameResultReducer(state, {
        type: GAME_RESULT_ACTIONS.RESULT_SESSION,
        payload: { expiresAt: deadline }
    });

    assert.equal(
        state.resultSessionExpiresAt,
        deadline,
        "same deadline preserved"
    );

    // A different later deadline must not extend the session.
    state = gameResultReducer(state, {
        type: GAME_RESULT_ACTIONS.RESULT_SESSION,
        payload: { expiresAt: deadline + 30_000 }
    });

    assert.equal(
        state.resultSessionExpiresAt,
        deadline,
        "must not extend lifetime on remount"
    );

    state = gameResultReducer(state, { type: GAME_RESULT_ACTIONS.RESET });

    assert.equal(
        state.resultSessionExpiresAt,
        null,
        "RESET clears deadline"
    );

    console.log("  RESULT_SESSION reducer: OK");
}

{
    const openedAt = 5_000_000;
    const durationMs = 5 * 60 * 1000;
    const expiresAt = openedAt + durationMs;

    // Simulate remount after 2 minutes of Result Session.
    const remountNow = openedAt + (2 * 60 * 1000);

    assert.equal(
        remainingResultSessionSeconds(expiresAt, remountNow),
        180,
        "remount recalculates remaining from absolute deadline"
    );

    assert.notEqual(
        remainingResultSessionSeconds(expiresAt, remountNow),
        300,
        "remount must not restart full duration"
    );

    console.log("  remount does not restart lifetime: OK");
}

console.log("resultSessionCountdown.test.js: all assertions passed");
