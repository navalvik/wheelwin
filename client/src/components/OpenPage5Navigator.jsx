import { useEffect, useRef } from "react";

import { APP_PAGES } from "../game/sessionRecovery/recoveryFlow";

import { useRegisterEngineModule } from "../context/EngineBridgeContext";

/**
 * R1.3D / P5.9 — Clients open Page5 / Page6 only on authoritative server events.
 * Production entry-payment → OPEN_PAGE5; RESULT completion → OPEN_PAGE6.
 */
export default function OpenPage5Navigator({ onNavigate }) {

    const onNavigateRef = useRef(onNavigate);

    useEffect(() => {

        onNavigateRef.current = onNavigate;

    }, [onNavigate]);

    useRegisterEngineModule("pageNavigation", () => {

        if (typeof onNavigateRef.current !== "function") {

            return null;

        }

        return {
            onOpenPage5: () => {

                onNavigateRef.current?.(APP_PAGES.GAMEPLAY);

            },
            onOpenPage6: () => {

                onNavigateRef.current?.(APP_PAGES.RESULT);

            }
        };

    });

    return null;

}
