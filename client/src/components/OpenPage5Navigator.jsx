import { useEffect, useRef } from "react";

import { APP_PAGES } from "../game/sessionRecovery/recoveryFlow";

import { useRegisterEngineModule } from "../context/EngineBridgeContext";

/**
 * R1.3D — Clients open Page5 only when the server broadcasts OPEN_PAGE5.
 * Production entry-payment completion and DEBUG_START_GAME share this path.
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

            }
        };

    });

    return null;

}
