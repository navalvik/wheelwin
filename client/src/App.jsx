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

import { DevNavigationContext } from "./context/DevNavigationContext";
import { GameSessionProvider } from "./context/GameSessionContext";
import { GameResultProvider } from "./context/GameResultContext";
import {
    DEV_DASHBOARD_ENABLED,
    DEV_MODE,
    DEV_PAGE_SEQUENCE
} from "./config/devMode";

const PageDeveloperDashboard = DEV_DASHBOARD_ENABLED
    ? lazy(() => import("./pages/PageDeveloperDashboard.jsx"))
    : null;

function GameFlow() {

    const [currentPage, setCurrentPage] = useState(1);

    function navigate(page) {

        setCurrentPage(page);

    }

    function jumpToNextPage() {

        setCurrentPage((prev) => {

            const index = DEV_PAGE_SEQUENCE.indexOf(prev);

            const nextIndex = index === -1
                ? 0
                : (index + 1) % DEV_PAGE_SEQUENCE.length;

            return DEV_PAGE_SEQUENCE[nextIndex];

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

        <GameSessionProvider
            currentPage={currentPage}
            onNavigate={navigate}
        >

            <GameResultProvider
                currentPage={currentPage}
                onNavigate={navigate}
            >

                <DevNavigationContext.Provider value={devNavigation}>

                    {renderPage()}

                </DevNavigationContext.Provider>

            </GameResultProvider>

        </GameSessionProvider>

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
