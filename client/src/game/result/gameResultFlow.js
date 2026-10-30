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
    RESULT_SESSION: "RESULT_SESSION",
    NAVIGATED: "NAVIGATED",
    RESET: "RESET"
});

const STORED_RESULT_KEY = "wheelwin.completedResult.v1";

function currentTelegramAccountId() {
    const userId = globalThis.window?.Telegram?.WebApp?.initDataUnsafe?.user?.id;
    return userId == null ? null : String(userId);
}

function readStoredIdentity() {
    try {
        const identity = JSON.parse(globalThis.sessionStorage?.getItem("wheelwin.setupRecoveryIdentity") ?? "null");
        return identity?.roomId && identity?.playerId ? identity : null;
    } catch {
        return null;
    }
}

function readStoredTerminalRecord(identity) {
    if (!identity?.playerId || !identity?.gameId) return null;
    try {
        const saved = JSON.parse(globalThis.sessionStorage?.getItem(STORED_RESULT_KEY) ?? "null");
        if (saved?.playerId !== identity.playerId || saved?.gameId !== identity.gameId) return null;
        const accountId = currentTelegramAccountId();
        if ((saved?.telegramAccountId && saved.telegramAccountId !== accountId)
            || (accountId && saved?.telegramAccountId !== accountId)) return null;
        const result = mapAuthoritativeResultToView(saved.result);
        return result?.gameId === identity.gameId ? saved : null;
    } catch {
        return null;
    }
}

export function readStoredTerminalState(identity = readStoredIdentity()) {
    const saved = readStoredTerminalRecord(identity);
    if (!saved) return null;
    return {
        result: mapAuthoritativeResultToView(saved.result),
        payment: mapPaymentStatusToView(saved.payment),
        audit: mapAuditStatusToView(saved.audit),
        resultSessionExpiresAt: Number.isFinite(saved.resultSessionExpiresAt)
            ? saved.resultSessionExpiresAt
            : null
    };
}

export function readStoredTerminalResult(identity = readStoredIdentity()) {
    return readStoredTerminalState(identity)?.result ?? null;
}

function updateStoredTerminalState(identity, update) {
    const prior = readStoredTerminalRecord(identity);
    if (!prior) return false;
    try {
        globalThis.sessionStorage?.setItem(STORED_RESULT_KEY, JSON.stringify({
            ...prior,
            ...update
        }));
        return true;
    } catch {
        return false;
    }
}

export function persistStoredTerminalResult(identity, payload) {
    if (!identity?.playerId || !payload?.gameId) return false;
    const result = mapAuthoritativeResultToView(payload);
    if (!result) return false;
    const saved = readStoredTerminalRecord(identity);
    try {
        globalThis.sessionStorage?.setItem(STORED_RESULT_KEY, JSON.stringify({
            ...(saved ?? {}),
            playerId: identity.playerId,
            gameId: result.gameId,
            telegramAccountId: currentTelegramAccountId(),
            result
        }));
        return true;
    } catch {
        return false;
    }
}

export function persistStoredTerminalPayment(identity, payload) {
    if (!identity?.gameId || payload?.gameId !== identity.gameId) return false;
    const payment = mapPaymentStatusToView(payload);
    return payment ? updateStoredTerminalState(identity, { payment }) : false;
}

export function persistStoredTerminalAudit(identity, payload) {
    if (!identity?.gameId || payload?.gameId !== identity.gameId) return false;
    const audit = mapAuditStatusToView(payload);
    return audit ? updateStoredTerminalState(identity, { audit }) : false;
}

export function persistStoredTerminalSession(identity, expiresAt) {
    return Number.isFinite(expiresAt)
        ? updateStoredTerminalState(identity, { resultSessionExpiresAt: expiresAt })
        : false;
}

export function clearStoredTerminalResult() {
    try {
        globalThis.sessionStorage?.removeItem(STORED_RESULT_KEY);
    } catch {
        // Storage can be unavailable in private or restricted WebViews.
    }
}

export function readStoredTerminalPage() {
    return readStoredTerminalResult() ? GAME_RESULT_PAGE.PAGE6 : null;
}

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
    // R12.5A — authoritative Page6 linger deadline (ResultSessionLifecycle).
    resultSessionExpiresAt: null,
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

        case GAME_RESULT_ACTIONS.RESULT_SESSION: {

            const expiresAt = Number.isFinite(action.payload?.expiresAt)
                ? action.payload.expiresAt
                : null;

            if (expiresAt === null) {

                return state;

            }

            // Keep the earliest authoritative deadline for this session.
            if (
                Number.isFinite(state.resultSessionExpiresAt)
                && state.resultSessionExpiresAt !== expiresAt
            ) {

                return state;

            }

            return {
                ...state,
                resultSessionExpiresAt: expiresAt
            };

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
