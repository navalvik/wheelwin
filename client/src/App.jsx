import { lazy, Suspense, useState } from "react";
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
import { GameSessionProvider } from "./context/GameSessionContext";
import { GameResultProvider } from "./context/GameResultContext";
import { PlayerIdentityProvider } from "./context/PlayerIdentityContext";
import { GameEngineProviders } from "./providers/GameEngineProviders";
import RecoveryOverlay from "./components/RecoveryOverlay";
import {
    DEV_DASHBOARD_ENABLED,
    DEV_MODE,
    DEV_PAGE_SEQUENCE
} from "./config/devMode";
import { APP_PAGES } from "./game/sessionRecovery/recoveryFlow";
import socket from "./socket/socket";
import { LOBBY_OUTGOING_EVENTS } from "./socket/socketEvents";

const PageDeveloperDashboard = DEV_DASHBOARD_ENABLED
    ? lazy(() => import("./pages/PageDeveloperDashboard.jsx"))
    : null;

function GameFlow() {

    const [currentPage, setCurrentPage] = useState(1);

    // R6.4 — bumping remounts all session providers so FINISH matches a fresh launch.
    const [sessionGeneration, setSessionGeneration] = useState(0);

    function navigate(page) {

        setCurrentPage(page);

    }

    function finishSession() {

        if (socket.connected) {

            socket.emit(LOBBY_OUTGOING_EVENTS.LEAVE_ROOM);

        }

        setCurrentPage(APP_PAGES.WELCOME);

        setSessionGeneration((generation) => generation + 1);

    }

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

    const devNavigation = DEV_MODE
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

            <GameSessionProvider
                currentPage={currentPage}
                onNavigate={navigate}
            >

                <GameResultProvider
                    currentPage={currentPage}
                    onNavigate={navigate}
                >

                    <DevNavigationContext.Provider value={devNavigation}>

                        {/*
                            Authoritative gameplay subscriptions live here,
                            at the flow root, so they are bound before
                            gameplay begins and survive every page
                            transition. They must not depend on Page5
                            mounting or the first GAME_STATE packets are
                            lost during navigation.

                            RecoveryExperienceProvider is nested inside
                            GameEngineProviders (after AuthoritativeSession,
                            before SessionRecovery) so useAuthoritativeSession
                            and useRecoveryExperience both resolve correctly.
                        */}
                        <GameEngineProviders
                            currentPage={currentPage}
                            onNavigate={navigate}
                        >

                            <OpenPage5Navigator onNavigate={navigate} />

                            {renderPage()}

                            <RecoveryOverlay />

                        </GameEngineProviders>

                    </DevNavigationContext.Provider>

                </GameResultProvider>

            </GameSessionProvider>

        </PlayerIdentityProvider>

    );

}

export default function App() {

    return (

        <Routes>

            {DEV_DASHBOARD_ENABLED && PageDeveloperDashboard && (

                <Route
                    path="/debug"
                    element={(
                        <Suspense fallback={null}>

                            <PageDeveloperDashboard />

                        </Suspense>
                    )}
                />

            )}

            <Route path="/*" element={<GameFlow />} />

        </Routes>

    );

}
