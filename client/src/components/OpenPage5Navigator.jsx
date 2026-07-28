import { useEffect, useRef } from "react";

import { APP_PAGES } from "../game/sessionRecovery/recoveryFlow";

import { useRegisterEngineModule } from "../context/EngineBridgeContext";

/**
 * R1.3D / P5.9 / R5.19 / R6.5 — Clients open Page5 / Page6 and finish sessions
 * only on authoritative server events (OPEN_PAGE5 / OPEN_PAGE6 /
 * SESSION_FINISHED). Never navigate on local RESULT / wheel / timeout.
 */
export default function OpenPage5Navigator({ onNavigate, onSessionFinished }) {

    const onNavigateRef = useRef(onNavigate);

    const onSessionFinishedRef = useRef(onSessionFinished);

    const openedPage6Ref = useRef(false);

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

                // New gameplay session may open Page6 again later.
                openedPage6Ref.current = false;

                onNavigateRef.current?.(APP_PAGES.GAMEPLAY);

            },
            onOpenPage6: () => {

                // R5.19 — navigate exactly once for the live end-of-game path.
                if (openedPage6Ref.current) {

                    return;

                }

                openedPage6Ref.current = true;

                onNavigateRef.current?.(APP_PAGES.RESULT);

            },
            onSessionFinished: (payload) => {

                onSessionFinishedRef.current?.(payload);

            }
        };

    });

    return null;

}
