import {
    GAME_RESULT_ACTIONS,
    GAME_RESULT_INITIAL_STATE,
    GAME_RESULT_PAGE,
    PAYMENT_VIEW_STATUS,
    AUDIT_VIEW_STATUS,
    gameResultReducer,
    mapAuthoritativeResultToView,
    mapPaymentStatusToView,
    mapAuditStatusToView,
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
// Navigation — P5.9: GAME_RESULT never navigates; OPEN_PAGE6 owns Page6.
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
        !shouldNavigateToResult(state, GAME_RESULT_PAGE.PAGE5),
        "GAME_RESULT must not navigate to Page6 (OPEN_PAGE6 owns transition)"
    );

    assert(
        !shouldNavigateToResult(state, GAME_RESULT_PAGE.PAGE6),
        "GAME_RESULT must not reopen Page6"
    );

    console.log("  navigation: GAME_RESULT does not navigate (P5.9) passed");

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

// ---------------------------------------------------------------------------
// Payment — authoritative status passthrough, no client calculation.
// ---------------------------------------------------------------------------

{

    const view = mapPaymentStatusToView({
        gameId: "game_abc",
        status: PAYMENT_VIEW_STATUS.COMPLETED,
        winnerId: "player_2",
        winnerAmount: 22.5,
        reason: null,
        serverTimestamp: 1730000000001
    });

    assert(view.status === "COMPLETED", "payment status should pass through");

    assert(view.winnerAmount === 22.5, "payout amount should pass through");

    assert(
        mapPaymentStatusToView({ status: "NONSENSE" }) === null,
        "unknown payment status must be rejected"
    );

    assert(
        mapPaymentStatusToView(null) === null,
        "null payment payload should map to null"
    );

    console.log("  payment: authoritative status passthrough passed");

}

// Payment lifecycle progresses STARTED -> COMPLETED, but never downgrades.
{

    let state = { ...GAME_RESULT_INITIAL_STATE };

    state = gameResultReducer(state, {
        type: GAME_RESULT_ACTIONS.PAYMENT_STATUS,
        payload: { gameId: "g", status: PAYMENT_VIEW_STATUS.STARTED }
    });

    assert(
        state.payment.status === PAYMENT_VIEW_STATUS.STARTED,
        "payment should capture the STARTED status"
    );

    state = gameResultReducer(state, {
        type: GAME_RESULT_ACTIONS.PAYMENT_STATUS,
        payload: {
            gameId: "g",
            status: PAYMENT_VIEW_STATUS.COMPLETED,
            winnerAmount: 22.5
        }
    });

    assert(
        state.payment.status === PAYMENT_VIEW_STATUS.COMPLETED,
        "payment should progress to COMPLETED"
    );

    // An out-of-order STARTED must not downgrade a terminal status.
    const downgrade = gameResultReducer(state, {
        type: GAME_RESULT_ACTIONS.PAYMENT_STATUS,
        payload: { gameId: "g", status: PAYMENT_VIEW_STATUS.STARTED }
    });

    assert(
        downgrade.payment.status === PAYMENT_VIEW_STATUS.COMPLETED,
        "terminal payment status must not downgrade to STARTED"
    );

    assert(
        downgrade === state,
        "no-op payment update should return the same state reference"
    );

    console.log("  payment: lifecycle progression / no downgrade passed");

}

// Payment state is independent of the winner result and cleared on reset.
{

    let state = { ...GAME_RESULT_INITIAL_STATE };

    state = gameResultReducer(state, {
        type: GAME_RESULT_ACTIONS.PAYMENT_STATUS,
        payload: { gameId: "g", status: PAYMENT_VIEW_STATUS.FAILED, reason: "x" }
    });

    assert(
        state.result === null,
        "payment status must not fabricate a game result"
    );

    assert(state.payment.status === "FAILED", "failed status should be stored");

    state = gameResultReducer(state, { type: GAME_RESULT_ACTIONS.RESET });

    assert(state.payment === null, "reset should clear payment status");

    console.log("  payment: independent of result and reset passed");

}

// ---------------------------------------------------------------------------
// Audit — authoritative status passthrough, no client audit generation.
// ---------------------------------------------------------------------------

{

    const view = mapAuditStatusToView({
        gameId: "game_abc",
        status: AUDIT_VIEW_STATUS.READY,
        auditId: "audit_seed_123",
        serverTimestamp: 1730000000002
    });

    assert(view.status === "READY", "audit status should pass through");

    assert(view.auditId === "audit_seed_123", "audit id should pass through");

    assert(
        view.serverTimestamp === 1730000000002,
        "audit timestamp should pass through"
    );

    assert(
        mapAuditStatusToView({ status: "NONSENSE" }) === null,
        "unknown audit status must be rejected"
    );

    assert(
        mapAuditStatusToView(null) === null,
        "null audit payload should map to null"
    );

    console.log("  audit: authoritative status passthrough passed");

}

// Audit lifecycle progresses STARTED -> READY, but never downgrades.
{

    let state = { ...GAME_RESULT_INITIAL_STATE };

    state = gameResultReducer(state, {
        type: GAME_RESULT_ACTIONS.AUDIT_STATUS,
        payload: { gameId: "g", status: AUDIT_VIEW_STATUS.STARTED }
    });

    assert(
        state.audit.status === AUDIT_VIEW_STATUS.STARTED,
        "audit should capture the STARTED status"
    );

    state = gameResultReducer(state, {
        type: GAME_RESULT_ACTIONS.AUDIT_STATUS,
        payload: {
            gameId: "g",
            status: AUDIT_VIEW_STATUS.READY,
            auditId: "audit_g_1"
        }
    });

    assert(
        state.audit.status === AUDIT_VIEW_STATUS.READY,
        "audit should progress to READY"
    );

    const downgrade = gameResultReducer(state, {
        type: GAME_RESULT_ACTIONS.AUDIT_STATUS,
        payload: { gameId: "g", status: AUDIT_VIEW_STATUS.STARTED }
    });

    assert(
        downgrade.audit.status === AUDIT_VIEW_STATUS.READY,
        "terminal audit status must not downgrade to STARTED"
    );

    assert(
        downgrade === state,
        "no-op audit update should return the same state reference"
    );

    console.log("  audit: lifecycle progression / no downgrade passed");

}

// Audit state is independent of the winner result and cleared on reset.
{

    let state = { ...GAME_RESULT_INITIAL_STATE };

    state = gameResultReducer(state, {
        type: GAME_RESULT_ACTIONS.AUDIT_STATUS,
        payload: { gameId: "g", status: AUDIT_VIEW_STATUS.FAILED }
    });

    assert(
        state.result === null,
        "audit status must not fabricate a game result"
    );

    assert(state.audit.status === "FAILED", "failed audit status should be stored");

    state = gameResultReducer(state, { type: GAME_RESULT_ACTIONS.RESET });

    assert(state.audit === null, "reset should clear audit status");

    console.log("  audit: independent of result and reset passed");

}

console.log("gameResultFlow.test.js: all assertions passed");
