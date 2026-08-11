import { useEffect, useRef } from "react";

import { APP_PAGES } from "../game/sessionRecovery/recoveryFlow";

import { page6LifecycleDiag } from "../game/result/page6LifecycleDiag";

import { useRegisterEngineModule } from "../context/EngineBridgeContext";

import socket from "../socket/socket";

/**
 * R1.3D / P5.9 / R5.19 / R6.5 — Clients open Page5 / Page6 and finish sessions
 * only on authoritative server events (OPEN_PAGE5 / OPEN_PAGE6 /
 * SESSION_FINISHED). Never navigate on local RESULT / wheel / timeout.
 */
export default function OpenPage5Navigator({
    onNavigate,
    onSessionFinished,
    onArmNewGameplaySession
}) {

    const onNavigateRef = useRef(onNavigate);

    const onSessionFinishedRef = useRef(onSessionFinished);

    const onArmNewGameplaySessionRef = useRef(onArmNewGameplaySession);

    const openedPage6Ref = useRef(false);

    useEffect(() => {

        onNavigateRef.current = onNavigate;

    }, [onNavigate]);

    useEffect(() => {

        onSessionFinishedRef.current = onSessionFinished;

    }, [onSessionFinished]);

    useEffect(() => {

        onArmNewGameplaySessionRef.current = onArmNewGameplaySession;

    }, [onArmNewGameplaySession]);

    useRegisterEngineModule("pageNavigation", () => {

        if (typeof onNavigateRef.current !== "function"
            && typeof onSessionFinishedRef.current !== "function") {

            return null;

        }

        return {
            onOpenPage5: () => {

                // New gameplay session may open Page6 again later.
                openedPage6Ref.current = false;

                onArmNewGameplaySessionRef.current?.();

                page6LifecycleDiag("NAV_OPEN_PAGE5", {
                    targetPage: APP_PAGES.GAMEPLAY,
                    socketConnected: socket.connected === true
                });

                onNavigateRef.current?.(APP_PAGES.GAMEPLAY);

            },
            onOpenPage6: (payload) => {

                // R5.19 — navigate exactly once for the live end-of-game path.
                if (openedPage6Ref.current) {

                    page6LifecycleDiag("NAV_OPEN_PAGE6_SKIPPED", {
                        reason: "already_opened",
                        roomId: payload?.roomId ?? null,
                        gameId: payload?.gameId ?? null,
                        resultSessionExpiresAt: Number.isFinite(payload?.expiresAt)
                            ? payload.expiresAt
                            : null,
                        socketConnected: socket.connected === true
                    });

                    return;

                }

                openedPage6Ref.current = true;

                page6LifecycleDiag("NAV_OPEN_PAGE6", {
                    targetPage: APP_PAGES.RESULT,
                    roomId: payload?.roomId ?? null,
                    gameId: payload?.gameId ?? null,
                    resultSessionExpiresAt: Number.isFinite(payload?.expiresAt)
                        ? payload.expiresAt
                        : null,
                    remainingMs: Number.isFinite(payload?.expiresAt)
                        ? payload.expiresAt - Date.now()
                        : null,
                    socketConnected: socket.connected === true
                });

                onNavigateRef.current?.(APP_PAGES.RESULT);

            },
            onSessionFinished: (payload) => {

                page6LifecycleDiag("CLIENT_SESSION_FINISHED_RECEIVED", {
                    roomId: payload?.roomId ?? null,
                    gameId: payload?.gameId ?? null,
                    reason: payload?.reason ?? null,
                    socketConnected: socket.connected === true,
                    willInvokeResetToWelcome: typeof onSessionFinishedRef.current
                        === "function"
                });

                onSessionFinishedRef.current?.("SESSION_FINISHED", payload);

            }
        };

    });

    return null;

}
