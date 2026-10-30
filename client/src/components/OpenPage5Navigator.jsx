import { useEffect, useRef } from "react";

import { APP_PAGES } from "../game/sessionRecovery/recoveryFlow";
import {
    isDuplicateOpenPage5,
    resolveOpenPage5GameKey
} from "../game/sessionRecovery/pageNavigationPolicy";

import { page6LifecycleDiag } from "../game/result/page6LifecycleDiag";

import { webPage6Diag } from "../game/result/webPage6StateDiag";

import { useRegisterEngineModule } from "../context/EngineBridgeContext";
import { usePlayerIdentity } from "../context/PlayerIdentityContext";

import socket from "../socket/socket";

/**
 * R1.3D / P5.9 / R5.19 / R6.5 — Clients open Page5 / Page6 and finish sessions
 * only on authoritative server events (OPEN_PAGE5 / OPEN_PAGE6 /
 * SESSION_FINISHED). Never navigate on local RESULT / wheel / timeout.
 */
export default function OpenPage5Navigator({
    currentPage,
    onNavigate,
    onSessionFinished,
    onArmNewGameplaySession
}) {

    const onNavigateRef = useRef(onNavigate);

    const onSessionFinishedRef = useRef(onSessionFinished);

    const onArmNewGameplaySessionRef = useRef(onArmNewGameplaySession);

    const { identity, setIdentity } = usePlayerIdentity();

    const identityRef = useRef(identity);

    const openedPage6Ref = useRef(false);

    const openedPage5GameRef = useRef(null);

    const currentPageRef = useRef(currentPage);

    useEffect(() => {
        currentPageRef.current = currentPage;
    }, [currentPage]);

    useEffect(() => {

        onNavigateRef.current = onNavigate;

    }, [onNavigate]);

    useEffect(() => {

        onSessionFinishedRef.current = onSessionFinished;

    }, [onSessionFinished]);

    useEffect(() => {

        onArmNewGameplaySessionRef.current = onArmNewGameplaySession;

    }, [onArmNewGameplaySession]);

    useEffect(() => {

        identityRef.current = identity;

    }, [identity]);

    useRegisterEngineModule("pageNavigation", () => {

        if (typeof onNavigateRef.current !== "function"
            && typeof onSessionFinishedRef.current !== "function") {

            return null;

        }

        return {
            onPaymentStageReady: (payload) => {

                const roomId = payload?.roomId;

                if (!roomId || identityRef.current?.roomId !== roomId) {

                    return;

                }

                onNavigateRef.current?.(APP_PAGES.PAYMENT);

            },
            onOpenPage5: (payload) => {

                if (payload?.roomId && identityRef.current?.roomId
                    && payload.roomId !== identityRef.current.roomId) {
                    return;
                }

                const gameKey = resolveOpenPage5GameKey(payload, identityRef.current);
                const previousGameId = identityRef.current?.gameId ?? null;
                const authoritativeNewGame = Boolean(
                    payload?.gameId
                    && previousGameId
                    && payload.gameId !== previousGameId
                );

                if (isDuplicateOpenPage5(openedPage5GameRef.current, payload, identityRef.current)) {
                    return;
                }

                if (currentPageRef.current === APP_PAGES.RESULT
                    && payload?.gameId
                    && payload.gameId === previousGameId) {
                    return;
                }

                if (gameKey) {
                    openedPage5GameRef.current = gameKey;
                }

                if (payload?.gameId) {
                    // The server event is authoritative and binds the live game
                    // identity for recovery and terminal-result storage.
                    identityRef.current = {
                        ...identityRef.current,
                        gameId: payload.gameId
                    };
                    setIdentity({ gameId: payload.gameId });
                }

                // New gameplay session may open Page6 again later.
                openedPage6Ref.current = false;

                onArmNewGameplaySessionRef.current?.();

                page6LifecycleDiag("NAV_OPEN_PAGE5", {
                    targetPage: APP_PAGES.GAMEPLAY,
                    socketConnected: socket.connected === true
                });

                webPage6Diag("NAVIGATION_PAGE5", {
                    fromPage: null,
                    toPage: APP_PAGES.GAMEPLAY,
                    source: "OpenPage5Navigator.onOpenPage5",
                    reason: "OPEN_PAGE5",
                    socketConnected: socket.connected === true
                });

                onNavigateRef.current?.(APP_PAGES.GAMEPLAY, {
                    authoritativeNewGame,
                    previousGameId,
                    gameId: payload?.gameId ?? null
                });

            },
            onOpenPage6: (payload) => {

                if ((payload?.roomId && identityRef.current?.roomId
                        && payload.roomId !== identityRef.current.roomId)
                    || (payload?.gameId && identityRef.current?.gameId
                        && payload.gameId !== identityRef.current.gameId)) {
                    return;
                }

                if (payload?.gameId && !identityRef.current?.gameId) {
                    identityRef.current = { ...identityRef.current, gameId: payload.gameId };
                    setIdentity({ gameId: payload.gameId });
                }

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

                    webPage6Diag("NAVIGATION_PAGE6", {
                        fromPage: null,
                        toPage: APP_PAGES.RESULT,
                        source: "OpenPage5Navigator.onOpenPage6",
                        reason: "skipped_already_opened",
                        blocked: true,
                        resultSessionExpiresAt: Number.isFinite(payload?.expiresAt)
                            ? payload.expiresAt
                            : null,
                        socketConnected: socket.connected === true
                    }, { force: true });

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

                webPage6Diag("NAVIGATION_PAGE6", {
                    fromPage: APP_PAGES.GAMEPLAY,
                    toPage: APP_PAGES.RESULT,
                    source: "OpenPage5Navigator.onOpenPage6",
                    reason: "OPEN_PAGE6",
                    blocked: false,
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
