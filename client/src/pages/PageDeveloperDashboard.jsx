import { useCallback } from "react";

import { Link } from "react-router-dom";

import DeveloperDashboardSections from "../components/dev/DeveloperDashboardSections";
import DeveloperDebugKeyboardHandler from "../components/dev/DeveloperDebugKeyboardHandler";
import Page5DevDebugPanel from "../components/page5/Page5DevDebugPanel";

import {
    DEFAULT_WHEEL_SECTOR_COUNT,
    getWheelDebugConfig
} from "../components/game/WheelEngine";

import { useWheelConfig } from "../context/WheelConfigContext";
import { GameEngineProviders } from "../providers/GameEngineProviders";

import "../styles/developerDashboard.css";

function DeveloperDashboardBridge() {

    const { wheelConfiguration, setWheelConfiguration } = useWheelConfig();

    const handleWheelSectorDebug = useCallback((sectorCount) => {

        setWheelConfiguration(getWheelDebugConfig(sectorCount));

    }, [setWheelConfiguration]);

    const sectorCount = wheelConfiguration?.sectors?.length
        ?? DEFAULT_WHEEL_SECTOR_COUNT;

    return (

        <>

            <DeveloperDebugKeyboardHandler
                onWheelConfigurationChange={handleWheelSectorDebug}
            />

            <div className="devDashboard">

                <header className="devDashboard__header">

                    <div>

                        <h1 className="devDashboard__title">

                            WheelWin Developer Dashboard

                        </h1>

                        <p className="devDashboard__subtitle">

                            Read-only diagnostics for local development.
                            Live updates via existing engine subscriptions.

                        </p>

                    </div>

                    <Link className="devDashboard__backLink" to="/">

                        Back to game flow

                    </Link>

                </header>

                <DeveloperDashboardSections wheelSectorCount={sectorCount} />

                <details className="devDashboard__compactPanel">

                    <summary>

                        Compact debug panel (legacy layout)

                    </summary>

                    <Page5DevDebugPanel />

                </details>

                <footer className="devDashboard__footer">

                    <p>

                        Keyboard shortcuts: sectors 3–6, game state ]/→,
                        result w/l, ping p, loss Shift+O, recover Shift+R,
                        player offline Shift+1–3, player 1 state Alt+r/s/b/v/x/d

                    </p>

                    <p className="devDashboard__footerNote">

                        Reserved modules: Physics Timeline, Replay Timeline,
                        Recovery Timeline, Performance Timeline, Memory Usage,
                        Server Health, Event Monitor, Command Log, Network
                        Statistics, FPS, Render Statistics, Component Tree.

                    </p>

                </footer>

            </div>

        </>

    );

}

export default function PageDeveloperDashboard() {

    return (

        <GameEngineProviders>

            <DeveloperDashboardBridge />

        </GameEngineProviders>

    );

}
