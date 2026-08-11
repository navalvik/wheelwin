import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useReducer
} from "react";

import { DEV_MODE } from "../config/devMode";

import {
    GAME_RESULT_ACTIONS,
    GAME_RESULT_INITIAL_STATE,
    gameResultReducer,
    shouldResetResult
} from "../game/result/gameResultFlow";

import { resolveResultSessionExpiresAt } from "../game/result/resultSessionCountdown";

import { useRegisterEngineModule } from "./EngineBridgeContext";

const GameResultContext = createContext(null);

function devLog(message) {

    if (DEV_MODE) {

        console.debug(`[GameResult] ${message}`);

    }

}

/**
 * C4.1 — Persistent owner of the authoritative game result.
 *
 * Lives ABOVE the page switch so the result survives the Page5 → Page6
 * transition (Page5's gameplay providers unmount on navigation). It captures the
 * authoritative server payload, automatically opens Page6 exactly once, and
 * exposes the result to Page6 for presentation only.
 */
export function GameResultProvider({ children, currentPage, onNavigate: _onNavigate }) {

    const [state, dispatch] = useReducer(
        gameResultReducer,
        GAME_RESULT_INITIAL_STATE
    );

    const publishAuthoritativeResult = useCallback((payload) => {

        devLog("GAME_RESULT received");

        dispatch({
            type: GAME_RESULT_ACTIONS.AUTHORITATIVE_RESULT,
            payload
        });

    }, []);

    const publishPaymentStatus = useCallback((payload) => {

        devLog(`PAYMENT status ${payload?.status ?? "?"}`);

        dispatch({
            type: GAME_RESULT_ACTIONS.PAYMENT_STATUS,
            payload
        });

    }, []);

    const publishAuditStatus = useCallback((payload) => {

        devLog(`AUDIT status ${payload?.status ?? "?"}`);

        dispatch({
            type: GAME_RESULT_ACTIONS.AUDIT_STATUS,
            payload
        });

    }, []);

    const publishResultSession = useCallback((payload) => {

        const expiresAt = resolveResultSessionExpiresAt(payload);

        if (expiresAt === null) {

            return;

        }

        devLog(`RESULT_SESSION expiresAt=${expiresAt}`);

        dispatch({
            type: GAME_RESULT_ACTIONS.RESULT_SESSION,
            payload: { expiresAt }
        });

    }, []);

    const applyRecoverySnapshot = useCallback((snapshot) => {

        if (snapshot?.gameResult) {

            publishAuthoritativeResult(snapshot.gameResult);

        }

        if (snapshot?.payment) {

            publishPaymentStatus({
                gameId: snapshot.gameId ?? null,
                status: snapshot.payment.status,
                winnerId: snapshot.gameResult?.winner?.id ?? null,
                winnerAmount: snapshot.payment.winnerAmount ?? null,
                reason: snapshot.payment.reason ?? null,
                serverTimestamp: snapshot.timestamp ?? Date.now()
            });

        }

        if (snapshot?.audit) {

            publishAuditStatus({
                gameId: snapshot.gameId ?? null,
                status: snapshot.audit.status,
                auditId: snapshot.audit.auditId ?? null,
                serverTimestamp: snapshot.timestamp ?? Date.now()
            });

        }

        // R12.5A — restore authoritative Page6 linger deadline for countdown.
        if (snapshot?.openPage6 === true || snapshot?.resultSessionExpiresAt) {

            publishResultSession(snapshot);

        }

    }, [
        publishAuthoritativeResult,
        publishPaymentStatus,
        publishAuditStatus,
        publishResultSession
    ]);

    // Clear a stale result whenever a fresh game begins (pre-gameplay pages).
    useEffect(() => {

        if (shouldResetResult(currentPage)) {

            dispatch({ type: GAME_RESULT_ACTIONS.RESET });

        }

    }, [currentPage]);

    // P5.9 / R12.5A — OPEN_PAGE6 stores Result Session expiresAt for display only.
    useRegisterEngineModule("gameResult", () => ({
        onOpenPage6: (payload) => {

            publishResultSession(payload);

        },
        publishAuthoritativeResult,
        publishPaymentStatus,
        publishAuditStatus
    }));

    // P5.9 — Page6 opens only via authoritative OPEN_PAGE6 (OpenPage5Navigator).
    // GAME_RESULT is stored for RESULT presentation on Page5; it does not navigate.

    const value = useMemo(() => ({
        result: state.result,
        payment: state.payment,
        audit: state.audit,
        resultSessionExpiresAt: state.resultSessionExpiresAt,
        hasResult: Boolean(state.result),
        publishAuthoritativeResult,
        publishPaymentStatus,
        publishAuditStatus,
        applyRecoverySnapshot
    }), [
        state.result,
        state.payment,
        state.audit,
        state.resultSessionExpiresAt,
        publishAuthoritativeResult,
        publishPaymentStatus,
        publishAuditStatus,
        applyRecoverySnapshot
    ]);

    return (

        <GameResultContext.Provider value={value}>

            {children}

        </GameResultContext.Provider>

    );

}

export function useGameResult() {

    const context = useContext(GameResultContext);

    if (!context) {

        throw new Error(
            "useGameResult must be used within GameResultProvider"
        );

    }

    return context;

}

export function useGameResultRecovery() {

    const context = useContext(GameResultContext);

    return {
        applyRecoverySnapshot: context?.applyRecoverySnapshot ?? (() => {})
    };

}

const NOOP = () => {};

/**
 * Safe accessor for producers (e.g. the gameplay winner module) that may render
 * outside a GameResultProvider in isolated tests. Returns a no-op publisher when
 * the provider is absent so the gameplay core never depends on the UI shell.
 */
export function useGameResultPublisher() {

    const context = useContext(GameResultContext);

    return context?.publishAuthoritativeResult ?? NOOP;

}

/**
 * Safe accessor exposing both authoritative producers (result + payment status)
 * for the Page5 gameplay bridge. Falls back to no-ops outside a provider.
 */
export function useGameResultProducers() {

    const context = useContext(GameResultContext);

    return {
        publishAuthoritativeResult: context?.publishAuthoritativeResult ?? NOOP,
        publishPaymentStatus: context?.publishPaymentStatus ?? NOOP,
        publishAuditStatus: context?.publishAuditStatus ?? NOOP
    };

}
