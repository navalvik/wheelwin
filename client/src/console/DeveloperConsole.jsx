import { useCallback, useEffect, useState } from "react";

import DeveloperConsoleShell from "./DeveloperConsoleShell";
import {
    ConsoleStreamProvider,
    useConsoleFocus
} from "./ConsoleStreamProvider";
import {
    DeveloperAuthProvider,
    useDeveloperAuth
} from "./DeveloperAuthProvider";
import { getConsoleSection } from "./consoleSections";
import {
    readRememberedSectionId,
    rememberSectionId
} from "./sectionMemory";

import ServerHealthPanel from "./panels/ServerHealthPanel";
import ClosedBetaPanel from "./panels/ClosedBetaPanel";
import LaunchReadinessPanel from "./panels/LaunchReadinessPanel";
import GeneralAvailabilityPanel from "./panels/GeneralAvailabilityPanel";
import PostLaunchOperationsPanel from "./panels/PostLaunchOperationsPanel";
import PlatformGovernancePanel from "./panels/PlatformGovernancePanel";
import RoomsExplorerPanel from "./panels/RoomsExplorerPanel";
import GameDetailPanel from "./panels/GameDetailPanel";
import PlayersInspectorPanel from "./panels/PlayersInspectorPanel";
import PaymentsPanel from "./panels/PaymentsPanel";
import TonConnectDiagnosticsPanel from "./panels/TonConnectDiagnosticsPanel";
import RecoveryPanel from "./panels/RecoveryPanel";
import SimulationPanel from "./panels/SimulationPanel";
import EventBusPanel from "./panels/EventBusPanel";
import MetricsPanel from "./panels/MetricsPanel";
import TimelinePanel from "./panels/TimelinePanel";
import DeveloperLogPanel from "./panels/DeveloperLogPanel";
import SettingsPanel from "./panels/SettingsPanel";
import SystemInformationPanel from "./panels/SystemInformationPanel";
import BlockchainStatusPanel from "./panels/BlockchainStatusPanel";
import MaintenancePanel from "./panels/MaintenancePanel";

function renderSection(sectionId) {

    switch (sectionId) {

        case "server-health":
            return <ServerHealthPanel />;

        case "system-info":
            return <SystemInformationPanel />;

        case "blockchain-status":
            return <BlockchainStatusPanel />;

        case "closed-beta":
            return <ClosedBetaPanel />;

        case "launch-readiness":
            return <LaunchReadinessPanel />;

        case "general-availability":
            return <GeneralAvailabilityPanel />;

        case "post-launch-operations":
            return <PostLaunchOperationsPanel />;

        case "platform-governance":
            return <PlatformGovernancePanel />;

        case "rooms":
            return <RoomsExplorerPanel />;

        case "games":
            return <GameDetailPanel />;

        case "players":
            return <PlayersInspectorPanel />;

        case "payments":
            return <PaymentsPanel />;

        case "tonconnect":
            return <TonConnectDiagnosticsPanel />;

        case "recovery":
            return <RecoveryPanel />;

        case "simulation":
            return <SimulationPanel />;

        case "event-bus":
            return <EventBusPanel />;

        case "metrics":
            return <MetricsPanel />;

        case "timeline":
            return <TimelinePanel />;

        case "logs":
            return <DeveloperLogPanel />;

        case "settings":
            return <SettingsPanel />;

        case "maintenance":
            return <MaintenancePanel />;

        default:
            return <ServerHealthPanel />;

    }

}

function ConsoleLockedPanel() {

    return (

        <section className="devConsole__panel" aria-label="Authentication required">

            <header className="devConsole__panelHeader">

                <h2 className="devConsole__panelTitle">

                    Secure Developer Access

                </h2>

            </header>

            <div className="devConsole__panelBody devConsole__panelBody--ops">

                <p className="devConsole__placeholder">

                    Sign in with your Developer credentials to open the
                    operations console. Gameplay sockets are not used here.
                </p>

            </div>

        </section>

    );

}

function DeveloperConsoleBody() {

    const [activeSectionId, setActiveSectionId] = useState(
        () => readRememberedSectionId()
    );

    const { setFocus } = useConsoleFocus();

    const { requiresLogin } = useDeveloperAuth();

    const onSelectSection = useCallback((sectionId) => {

        const next = getConsoleSection(sectionId).id;

        setActiveSectionId(next);

        rememberSectionId(next);

        if (next !== "rooms" && next !== "games" && next !== "tonconnect") {

            setFocus({ roomId: null, gameId: null });

        }

    }, [setFocus]);

    useEffect(() => {

        rememberSectionId(activeSectionId);

    }, [activeSectionId]);

    return (

        <DeveloperConsoleShell
            activeSectionId={activeSectionId}
            onSelectSection={onSelectSection}
        >

            {requiresLogin
                ? <ConsoleLockedPanel />
                : renderSection(activeSectionId)}

        </DeveloperConsoleShell>

    );

}

function DeveloperConsoleStreamGate({ children }) {

    const { requiresLogin, accessToken, status, authEnabled } = useDeveloperAuth();

    const ready = status === "authenticated"
        || status === "open"
        || (!authEnabled && status !== "loading");

    const autoConnect = ready && !requiresLogin;

    return (

        <ConsoleStreamProvider
            autoConnect={autoConnect}
            accessToken={authEnabled ? accessToken : null}
        >

            {children}

        </ConsoleStreamProvider>

    );

}

/**
 * WheelWin Developer Console root (R6.1 secured).
 */
export default function DeveloperConsole() {

    return (

        <DeveloperAuthProvider>

            <DeveloperConsoleStreamGate>

                <DeveloperConsoleBody />

            </DeveloperConsoleStreamGate>

        </DeveloperAuthProvider>

    );

}
