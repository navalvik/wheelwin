import { useEffect } from "react";

import { RESULT_OUTCOMES } from "../../game/centralButton";
import { devLog } from "../../utils/devLog";
import {
    useSessionRecovery
} from "../../context/SessionRecoveryContext";
import { useSocketSync } from "../../context/SocketSyncContext";
import { PLAYER_UI_STATES } from "../../context/PlayerUIContext";
import { useDeveloperDiagnostics } from "./useDeveloperDiagnostics";

export default function DeveloperDebugKeyboardHandler({
    onWheelConfigurationChange
}) {

    const {
        setDebugResultOutcome,
        togglePlayerOnline,
        setDebugPlayerState
    } = useDeveloperDiagnostics();

    const { sendPing, disconnectSocket } = useSocketSync();

    const { requestRecovery } = useSessionRecovery();

    useEffect(() => {

        function handleKeyDown(event) {

            if (event.target instanceof HTMLInputElement
                || event.target instanceof HTMLTextAreaElement) {

                return;

            }

            const parsed = Number(event.key);

            if (parsed >= 3 && parsed <= 6) {

                onWheelConfigurationChange?.(parsed);

                devLog(`[WheelEngine] Debug configuration: ${parsed} sectors`);

                return;

            }

            if (event.key === "p") {

                sendPing();

                devLog("[SocketSync] Ping sent");

                return;

            }

            if (event.shiftKey && event.key === "O") {

                disconnectSocket?.();

                devLog("[SessionRecovery] Simulated connection loss");

                return;

            }

            if (event.shiftKey && event.key === "R") {

                requestRecovery();

                devLog("[SessionRecovery] Manual recovery requested");

                return;

            }

            if (event.key === "w") {

                setDebugResultOutcome(RESULT_OUTCOMES.WIN);

                return;

            }

            if (event.key === "l") {

                setDebugResultOutcome(RESULT_OUTCOMES.LOST);

                return;

            }

            if (event.shiftKey && parsed >= 1 && parsed <= 3) {

                togglePlayerOnline(parsed);

                devLog(`[PlayerUI] Toggled online for player ${parsed}`);

                return;

            }

            const debugStateByKey = {
                r: PLAYER_UI_STATES.READY,
                s: PLAYER_UI_STATES.SPEED,
                b: PLAYER_UI_STATES.BRAKE,
                v: PLAYER_UI_STATES.WIN,
                x: PLAYER_UI_STATES.LOST,
                d: PLAYER_UI_STATES.OFFLINE
            };

            const debugState = debugStateByKey[event.key];

            if (debugState && event.altKey) {

                setDebugPlayerState(1, debugState);

                devLog(`[PlayerUI] Player 1 state: ${debugState}`);

            }

        }

        window.addEventListener("keydown", handleKeyDown);

        return () => window.removeEventListener("keydown", handleKeyDown);

    }, [
        onWheelConfigurationChange,
        sendPing,
        disconnectSocket,
        requestRecovery,
        setDebugResultOutcome,
        togglePlayerOnline,
        setDebugPlayerState
    ]);

    return null;

}
