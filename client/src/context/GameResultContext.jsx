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
    GAME_RESULT_PAGE,
    gameResultReducer,
    shouldNavigateToResult,
    shouldResetResult
} from "../game/result/gameResultFlow";

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
export function GameResultProvider({ children, currentPage, onNavigate }) {

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

    // Clear a stale result whenever a fresh game begins (pre-gameplay pages).
    useEffect(() => {

        if (shouldResetResult(currentPage)) {

            dispatch({ type: GAME_RESULT_ACTIONS.RESET });

        }

    }, [currentPage]);

    // Automatic, one-time navigation to Page6 once the authoritative result
    // arrives while the player is still on Page5.
    useEffect(() => {

        if (!shouldNavigateToResult(state, currentPage)) {

            return;

        }

        devLog("Opening Page6");

        dispatch({ type: GAME_RESULT_ACTIONS.NAVIGATED });

        onNavigate(GAME_RESULT_PAGE.PAGE6);

    }, [state, currentPage, onNavigate]);

    const value = useMemo(() => ({
        result: state.result,
        hasResult: Boolean(state.result),
        publishAuthoritativeResult
    }), [state.result, publishAuthoritativeResult]);

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

/**
 * Safe accessor for producers (e.g. the gameplay winner module) that may render
 * outside a GameResultProvider in isolated tests. Returns a no-op publisher when
 * the provider is absent so the gameplay core never depends on the UI shell.
 */
export function useGameResultPublisher() {

    const context = useContext(GameResultContext);

    return context?.publishAuthoritativeResult ?? (() => {});

}
