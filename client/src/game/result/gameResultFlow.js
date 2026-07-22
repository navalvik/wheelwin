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
    PAYMENT_STATUS: "PAYMENT_STATUS",
    AUDIT_STATUS: "AUDIT_STATUS",
    NAVIGATED: "NAVIGATED",
    RESET: "RESET"
});

// Authoritative payment lifecycle statuses as forwarded by the server.
export const PAYMENT_VIEW_STATUS = Object.freeze({
    STARTED: "STARTED",
    COMPLETED: "COMPLETED",
    FAILED: "FAILED"
});

const TERMINAL_PAYMENT_STATUSES = Object.freeze([
    PAYMENT_VIEW_STATUS.COMPLETED,
    PAYMENT_VIEW_STATUS.FAILED
]);

// Authoritative audit lifecycle statuses as forwarded by the server.
export const AUDIT_VIEW_STATUS = Object.freeze({
    STARTED: "STARTED",
    READY: "READY",
    FAILED: "FAILED"
});

const TERMINAL_AUDIT_STATUSES = Object.freeze([
    AUDIT_VIEW_STATUS.READY,
    AUDIT_VIEW_STATUS.FAILED
]);

export const GAME_RESULT_INITIAL_STATE = Object.freeze({
    result: null,
    payment: null,
    audit: null,
    navigated: false
});

function isTerminalPaymentStatus(status) {

    return TERMINAL_PAYMENT_STATUSES.includes(status);

}

function isTerminalAuditStatus(status) {

    return TERMINAL_AUDIT_STATUSES.includes(status);

}

/**
 * Maps an authoritative audit status payload to the Page6 view. The status is
 * server-provided; the client never generates audit records or references.
 */
export function mapAuditStatusToView(payload) {

    if (!payload || !payload.status) {

        return null;

    }

    if (!Object.values(AUDIT_VIEW_STATUS).includes(payload.status)) {

        return null;

    }

    return {
        gameId: payload.gameId ?? null,
        status: payload.status,
        auditId: payload.auditId ?? null,
        serverTimestamp: payload.serverTimestamp ?? null,
        gameReport: payload.gameReport ?? null
    };

}

/**
 * Maps an authoritative payment status payload to the Page6 view. The status is
 * server-provided; the client never computes payout, fees, or status.
 */
export function mapPaymentStatusToView(payload) {

    if (!payload || !payload.status) {

        return null;

    }

    if (!Object.values(PAYMENT_VIEW_STATUS).includes(payload.status)) {

        return null;

    }

    return {
        gameId: payload.gameId ?? null,
        status: payload.status,
        winnerId: payload.winnerId ?? null,
        winnerAmount: payload.winnerAmount ?? null,
        reason: payload.reason ?? null,
        serverTimestamp: payload.serverTimestamp ?? null
    };

}

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

        case GAME_RESULT_ACTIONS.PAYMENT_STATUS: {

            const view = mapPaymentStatusToView(action.payload);

            if (!view) {

                return state;

            }

            // Never downgrade an authoritative terminal status (COMPLETED /
            // FAILED) back to an in-progress one if messages arrive out of order.
            if (
                state.payment
                && isTerminalPaymentStatus(state.payment.status)
                && !isTerminalPaymentStatus(view.status)
            ) {

                return state;

            }

            return { ...state, payment: view };

        }

        case GAME_RESULT_ACTIONS.AUDIT_STATUS: {

            const view = mapAuditStatusToView(action.payload);

            if (!view) {

                return state;

            }

            // Never downgrade an authoritative terminal audit status (READY /
            // FAILED) back to STARTED if messages arrive out of order.
            if (
                state.audit
                && isTerminalAuditStatus(state.audit.status)
                && !isTerminalAuditStatus(view.status)
            ) {

                return state;

            }

            return { ...state, audit: view };

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
 * P5.9 — Page6 navigation is owned by OPEN_PAGE6, not GAME_RESULT.
 * Kept for tests / legacy callers; always returns false.
 */
export function shouldNavigateToResult(_state, _currentPage) {

    return false;

}

/**
 * Whether the flow should be reset for a fresh game. Any pre-gameplay page
 * clears a stale result so the next game starts clean.
 */
export function shouldResetResult(currentPage) {

    return currentPage < GAME_RESULT_PAGE.PAGE5;

}
