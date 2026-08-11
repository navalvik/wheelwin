import { lazy, Suspense, useCallback, useRef, useState } from "react";
import { Routes, Route } from "react-router-dom";

import Page1Welcome from "./pages/Page1Welcome";
import RoomLobby from "./pages/RoomLobby";
import Page2PlayerSetup from "./pages/Page2PlayerSetup";
import PageMatrix from "./pages/PageMatrix";
import Page3VerifyPlayers from "./pages/Page3VerifyPlayers";
import Page4Payment from "./pages/Page4Payment";
import Page5Game from "./pages/Page5Game";
import Page6Result from "./pages/Page6Result";

import OpenPage5Navigator from "./components/OpenPage5Navigator";

import { DevNavigationContext } from "./context/DevNavigationContext";
import { LanguageProvider } from "./context/LanguageContext";
import { PlayerIdentityProvider } from "./context/PlayerIdentityContext";
import { GameEngineProviders } from "./providers/GameEngineProviders";
import RecoveryOverlay from "./components/RecoveryOverlay";
import {
    DEV_CONSOLE_ENABLED,
    DEBUG_JUMP_ENABLED,
    DEV_MODE,
    DEV_PAGE_SEQUENCE
} from "./config/devMode";
import { APP_PAGES } from "./game/sessionRecovery/recoveryFlow";
import { useTerminalNavigation } from "./game/session/useTerminalNavigation";
import { page6LifecycleDiag } from "./game/result/page6LifecycleDiag";
import { webPage6Diag } from "./game/result/webPage6StateDiag";
import socket from "./socket/socket";
import { LOBBY_OUTGOING_EVENTS } from "./socket/socketEvents";

const PageDeveloperConsole = DEV_CONSOLE_ENABLED
    ? lazy(() => import("./pages/PageDeveloperConsole.jsx"))
    : null;

function GameFlow() {

    const [currentPage, setCurrentPage] = useState(1);

    // R6.4 / R6.5 — bumping remounts all session providers so reset matches a fresh launch.
    const [sessionGeneration, setSessionGeneration] = useState(0);

    const currentPageRef = useRef(currentPage);

    currentPageRef.current = currentPage;

    function navigate(page) {

        const fromPage = currentPage;

        if (page === APP_PAGES.RESULT || page === APP_PAGES.GAMEPLAY) {

            webPage6Diag(
                page === APP_PAGES.RESULT
                    ? "NAVIGATION_PAGE6"
                    : "NAVIGATION_PAGE5",
                {
                    fromPage,
                    toPage: page,
                    source: "App.navigate",
                    reason: "setCurrentPage",
                    currentPageBefore: fromPage,
                    currentPageAfter: page
                }
            );

        }

        setCurrentPage(page);

    }

    const performTerminalReset = useCallback(() => {

        setCurrentPage(APP_PAGES.WELCOME);

        setSessionGeneration((generation) => generation + 1);

    }, []);

    const { resetToWelcome, armNewGameplaySession } = useTerminalNavigation({
        sessionGeneration,
        performReset: performTerminalReset
    });

    /**
     * R12.5H — SESSION_FINISHED must not auto-leave an already displayed Page6.
     * FINISH is the only client Page6 → Page1 navigation action.
     */
    const handleSessionFinished = useCallback((event) => {

        if (currentPageRef.current === APP_PAGES.RESULT) {

            page6LifecycleDiag("SESSION_FINISHED_IGNORED_ON_PAGE6", {
                reason: event,
                currentPage: APP_PAGES.RESULT
            });

            webPage6Diag("SESSION_FINISHED_IGNORED_ON_PAGE6", {
                reason: event,
                currentPage: APP_PAGES.RESULT,
                source: "App.handleSessionFinished"
            });

            return;

        }

        resetToWelcome(event);

    }, [resetToWelcome]);

    /**
     * R6.4 / R7.70C20 / R12.5H — FINISH is per-player and idempotent.
     * Navigate this client to Page1 and detach from the room without
     * broadcasting SESSION_FINISHED to other players still on Page6.
     * Does not wait for RESULT_SESSION_EXPIRED / SESSION_FINISHED.
     */
    function finishSession() {

        page6LifecycleDiag("PAGE6_FINISH_CLICK", {
            currentPage: currentPageRef.current
        });

        webPage6Diag("PAGE6_FINISH_CLICK", {
            currentPage: currentPageRef.current,
            source: "App.finishSession"
        });

        try {

            if (typeof window !== "undefined" && window.sessionStorage) {

                window.sessionStorage.removeItem("wheelwin.setupRecoveryIdentity");
                window.sessionStorage.removeItem("wheelwin.setupRecoveryPage");

            }

        } catch {

            // Ignore storage failures — local reset still proceeds.

        }

        const navigated = resetToWelcome("PAGE6_FINISH");

        if (!navigated) {

            return;

        }

        if (socket.connected) {

            socket.emit(LOBBY_OUTGOING_EVENTS.LEAVE_ROOM);

        }

        page6LifecycleDiag("PAGE6_FINISH_NAVIGATE", {
            currentPageBefore: currentPageRef.current,
            targetPage: APP_PAGES.WELCOME
        });

        webPage6Diag("PAGE6_FINISH_NAVIGATE", {
            fromPage: currentPageRef.current,
            toPage: APP_PAGES.WELCOME,
            source: "App.finishSession",
            reason: "PAGE6_FINISH"
        });

    }

    /**
     * Developer Stub — temporary page-sequence navigation (DEBUG_JUMP_ENABLED).
     * Reserved for future debugging; not rendered when the flag is false.
     */
    function jumpToNextPage() {

        setCurrentPage((prev) => {

            const index = DEV_PAGE_SEQUENCE.indexOf(prev);

            const nextIndex = index === -1
                ? 0
                : (index + 1) % DEV_PAGE_SEQUENCE.length;

            const next = DEV_PAGE_SEQUENCE[nextIndex];

            // R1.3D — never client-navigate to Page5. Ask the server to run the
            // production ENTRY_PAYMENT_COMPLETED → OPEN_PAGE5 sequence.
            if (next === APP_PAGES.GAMEPLAY) {

                if (socket.connected) {

                    socket.emit(LOBBY_OUTGOING_EVENTS.DEBUG_START_GAME);

                }

                return prev;

            }

            return next;

        });

    }

    const devNavigation = DEV_MODE && DEBUG_JUMP_ENABLED
        ? { enabled: true, onJump: jumpToNextPage }
        : null;

    function renderPage() {

        switch (currentPage) {

            case 1:

                return (

                    <Page1Welcome

                        onNext={() => navigate(2)}

                    />

                );

            case 2:

                return (

                    <RoomLobby

                        onNavigate={navigate}

                    />

                );

            case 3:

                return (

                    <Page2PlayerSetup

                        onNavigate={navigate}

                    />

                );

            case 4:

                return (

                    <PageMatrix

                        onNavigate={navigate}

                    />

                );

            case 5:

                return (

                    <Page3VerifyPlayers

                        onNavigate={navigate}

                    />

                );

            case 6:

                return (

                    <Page4Payment

                        onNavigate={navigate}

                    />

                );

            case 7:

                return (

                    <Page5Game

                        onNavigate={navigate}

                    />

                );

            case 8:

                return (

                    <Page6Result

                        onNavigate={navigate}
                        onFinish={finishSession}

                    />

                );

            default:

                return (

                    <Page1Welcome

                        onNext={() => navigate(2)}

                    />

                );

        }

    }

    return (

        <PlayerIdentityProvider key={sessionGeneration}>

            <DevNavigationContext.Provider value={devNavigation}>

                {/*
                    Authoritative gameplay subscriptions live here,
                    at the flow root, so they are bound before
                    gameplay begins and survive every page
                    transition. They must not depend on Page5
                    mounting or the first GAME_STATE packets are
                    lost during navigation.

                    GameSession / GameResult / RecoveryExperience are
                    owned by GameEngineProviders (single stack for
                    gameplay). Pass currentPage + onNavigate so Recovery
                    can navigate. The Developer Console (/debug) uses its
                    own tree and does not mount this stack.
                */}
                <GameEngineProviders
                    currentPage={currentPage}
                    onNavigate={navigate}
                    resetToWelcome={resetToWelcome}
                    sessionGeneration={sessionGeneration}
                >

                    <OpenPage5Navigator
                        onNavigate={navigate}
                        onSessionFinished={handleSessionFinished}
                        onArmNewGameplaySession={armNewGameplaySession}
                    />

                    {renderPage()}

                    <RecoveryOverlay />

                </GameEngineProviders>

            </DevNavigationContext.Provider>

        </PlayerIdentityProvider>

    );

}

export default function App() {

    return (

        <LanguageProvider>

            <Routes>

                {DEV_CONSOLE_ENABLED && PageDeveloperConsole && (

                    <Route
                        path="/debug"
                        element={(
                            <Suspense fallback={null}>

                                <PageDeveloperConsole />

                            </Suspense>
                        )}
                    />

                )}

                <Route path="/*" element={<GameFlow />} />

            </Routes>

        </LanguageProvider>

    );

}
