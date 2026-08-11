/**
 * R12.5A / R12.5B — Page6 Result Session countdown (display-only).
 */
import assert from "node:assert/strict";

import {
    formatResultSessionClock,
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
    assert.equal(formatResultSessionClock(299), "04:59");
    assert.equal(formatResultSessionClock(180), "03:00");
    assert.equal(formatResultSessionClock(61), "01:01");
    assert.equal(formatResultSessionClock(1), "00:01");
    assert.equal(formatResultSessionClock(0), "00:00");
    assert.equal(formatResultSessionClock(-5), "00:00", "never negative clock");
    assert.equal(formatResultSessionClock(null), null);

    const now = 1_000_000;
    const fiveMinAhead = now + (5 * 60 * 1000);

    assert.equal(
        formatResultSessionClock(
            remainingResultSessionSeconds(fiveMinAhead, now)
        ),
        "05:00"
    );

    assert.equal(
        formatResultSessionClock(
            remainingResultSessionSeconds(fiveMinAhead, now + 1000)
        ),
        "04:59"
    );

    console.log("  formatResultSessionClock MM:SS: OK");
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

    state = gameResultReducer(state, {
        type: GAME_RESULT_ACTIONS.RESULT_SESSION,
        payload: { expiresAt: deadline }
    });

    assert.equal(
        state.resultSessionExpiresAt,
        deadline,
        "same deadline preserved"
    );

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
    const remountNow = openedAt + (2 * 60 * 1000);

    assert.equal(
        remainingResultSessionSeconds(expiresAt, remountNow),
        180,
        "remount recalculates remaining from absolute deadline"
    );

    assert.equal(
        formatResultSessionClock(
            remainingResultSessionSeconds(expiresAt, remountNow)
        ),
        "03:00",
        "remount shows remaining MM:SS not full 05:00"
    );

    console.log("  remount does not restart lifetime: OK");
}

console.log("resultSessionCountdown.test.js: all assertions passed");
