import { useEffect, useRef } from "react";

import { APP_PAGES } from "../game/sessionRecovery/recoveryFlow";

import { useRegisterEngineModule } from "../context/EngineBridgeContext";

/**
 * R1.3D / P5.9 / R6.5 — Clients open Page5 / Page6 and finish sessions only on
 * authoritative server events.
 */
export default function OpenPage5Navigator({ onNavigate, onSessionFinished }) {

    const onNavigateRef = useRef(onNavigate);

    const onSessionFinishedRef = useRef(onSessionFinished);

    useEffect(() => {

        onNavigateRef.current = onNavigate;

    }, [onNavigate]);

    useEffect(() => {

        onSessionFinishedRef.current = onSessionFinished;

    }, [onSessionFinished]);

    useRegisterEngineModule("pageNavigation", () => {

        if (typeof onNavigateRef.current !== "function"
            && typeof onSessionFinishedRef.current !== "function") {

            return null;

        }

        return {
            onOpenPage5: () => {

                onNavigateRef.current?.(APP_PAGES.GAMEPLAY);

            },
            onOpenPage6: () => {

                onNavigateRef.current?.(APP_PAGES.RESULT);

            },
            onSessionFinished: (payload) => {

                onSessionFinishedRef.current?.(payload);

            }
        };

    });

    return null;

}
