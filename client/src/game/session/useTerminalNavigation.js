import { useCallback, useRef } from "react";

import { APP_PAGES } from "../sessionRecovery/recoveryFlow";

import { logTerminalNav } from "./gameplayTerminal.js";

/**
 * R12.2 — Idempotent terminal navigation guard for App.jsx resetToWelcome.
 * Guard clears when OPEN_PAGE5 arms a new gameplay session.
 */
export function useTerminalNavigation({
    sessionGeneration,
    performReset
}) {

    const terminalHandledRef = useRef(false);

    const sessionGenerationRef = useRef(sessionGeneration);

    sessionGenerationRef.current = sessionGeneration;

    const armNewGameplaySession = useCallback(() => {

        terminalHandledRef.current = false;

    }, []);

    const resetToWelcome = useCallback((event = "resetToWelcome") => {

        if (terminalHandledRef.current) {

            logTerminalNav({
                event,
                currentPage: APP_PAGES.WELCOME,
                sessionGeneration: sessionGenerationRef.current,
                skipped: true
            });

            return;

        }

        terminalHandledRef.current = true;

        logTerminalNav({
            event,
            currentPage: APP_PAGES.WELCOME,
            sessionGeneration: sessionGenerationRef.current
        });

        performReset();

    }, [performReset]);

    return {
        armNewGameplaySession,
        resetToWelcome
    };

}
