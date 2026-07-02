// C4.1 — Pure, framework-agnostic Result-experience logic.
//
// This module owns the decision of how the authoritative server GAME_RESULT is
// stored and when the client should present Page6. It performs NO winner
// calculation: the winner, sector, colour and icon are copied verbatim from the
// authoritative server payload. It never reads wheelAngle to infer a winner.
//
// Kept free of React and import.meta so it can be unit-tested under plain Node.

export const GAME_RESULT_PAGE = Object.freeze({
    PAGE5: 7,
    PAGE6: 8
});

export const GAME_RESULT_ACTIONS = Object.freeze({
    AUTHORITATIVE_RESULT: "AUTHORITATIVE_RESULT",
    NAVIGATED: "NAVIGATED",
    RESET: "RESET"
});

export const GAME_RESULT_INITIAL_STATE = Object.freeze({
    result: null,
    navigated: false
});

/**
 * Maps the raw authoritative GAME_RESULT payload to the presentation view used
 * by Page6. This is a strict passthrough of server-provided values — no field
 * is derived, computed, or inferred on the client.
 *
 * Returns null when the payload does not carry an authoritative winner, so the
 * client can never fabricate a result.
 */
export function mapAuthoritativeResultToView(payload) {

    if (!payload || !payload.winner || !payload.winningSector) {

        return null;

    }

    return {
        gameId: payload.gameId ?? null,
        winner: {
            id: payload.winner.id ?? null,
            color: payload.winner.color ?? null,
            icon: payload.winner.icon ?? null
        },
        winningSector: {
            index: payload.winningSector.index ?? null,
            sectorId: payload.winningSector.sectorId ?? null,
            color: payload.winningSector.color ?? null,
            icon: payload.winningSector.icon ?? null
        },
        finalWheelAngle: payload.finalWheelAngle ?? null,
        serverTimestamp: payload.serverTimestamp ?? null
    };

}

export function gameResultReducer(state, action) {

    switch (action?.type) {

        case GAME_RESULT_ACTIONS.AUTHORITATIVE_RESULT: {

            // Idempotent: the first authoritative result wins. Repeated
            // GAME_RESULT messages for the same game are ignored so Page6 is
            // never reopened or overwritten.
            if (state.result) {

                return state;

            }

            const view = mapAuthoritativeResultToView(action.payload);

            if (!view) {

                return state;

            }

            return { ...state, result: view };

        }

        case GAME_RESULT_ACTIONS.NAVIGATED: {

            if (state.navigated) {

                return state;

            }

            return { ...state, navigated: true };

        }

        case GAME_RESULT_ACTIONS.RESET:

            return { ...GAME_RESULT_INITIAL_STATE };

        default:

            return state;

    }

}

/**
 * Decides whether the client should automatically open Page6. Navigation is
 * allowed only once, only when an authoritative result exists, and only while
 * the player is still on Page5.
 */
export function shouldNavigateToResult(state, currentPage) {

    return Boolean(
        state.result
        && !state.navigated
        && currentPage === GAME_RESULT_PAGE.PAGE5
    );

}

/**
 * Whether the flow should be reset for a fresh game. Any pre-gameplay page
 * clears a stale result so the next game starts clean.
 */
export function shouldResetResult(currentPage) {

    return currentPage < GAME_RESULT_PAGE.PAGE5;

}
