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
import AdvertisingPanel from "./panels/AdvertisingPanel";
import TonConnectDiagnosticsPanel from "./panels/TonConnectDiagnosticsPanel";
import HistoryPanel from "./panels/HistoryPanel";
import RecoveryPanel from "./panels/RecoveryPanel";
import SimulationPanel from "./panels/SimulationPanel";
import EventBusPanel from "./panels/EventBusPanel";
import MetricsPanel from "./panels/MetricsPanel";
import TimelinePanel from "./panels/TimelinePanel";
import DeveloperLogPanel from "./panels/DeveloperLogPanel";
import SettingsPanel from "./panels/SettingsPanel";
import SystemInformationPanel from "./panels/SystemInformationPanel";
import BlockchainStatusPanel from "./panels/BlockchainStatusPanel";
import DeployerWalletPanel from "./panels/DeployerWalletPanel";
import MaintenancePanel from "./panels/MaintenancePanel";
import ConfigurationPlaceholderPanel from "./panels/ConfigurationPlaceholderPanel";
import RuntimeConfigurationPanel from "./panels/RuntimeConfigurationPanel";

/** Section id → panel factory. Kept in sync with consoleSections.js ids. */
const SECTION_PANEL_RENDERERS = Object.freeze({
    "server-health": () => <ServerHealthPanel />,
    "system-info": () => <SystemInformationPanel />,
    "blockchain-status": () => <BlockchainStatusPanel />,
    "ton-deployer-wallet": () => <DeployerWalletPanel />,
    "closed-beta": () => <ClosedBetaPanel />,
    "launch-readiness": () => <LaunchReadinessPanel />,
    "general-availability": () => <GeneralAvailabilityPanel />,
    "post-launch-operations": () => <PostLaunchOperationsPanel />,
    "platform-governance": () => <PlatformGovernancePanel />,
    rooms: () => <RoomsExplorerPanel />,
    games: () => <GameDetailPanel />,
    players: () => <PlayersInspectorPanel />,
    payments: () => <PaymentsPanel />,
    advertising: () => <AdvertisingPanel />,
    tonconnect: () => <TonConnectDiagnosticsPanel />,
    history: () => <HistoryPanel />,
    recovery: () => <RecoveryPanel />,
    simulation: () => <SimulationPanel />,
    "event-bus": () => <EventBusPanel />,
    metrics: () => <MetricsPanel />,
    timeline: () => <TimelinePanel />,
    logs: () => <DeveloperLogPanel />,
    settings: () => <SettingsPanel />,
    maintenance: () => <MaintenancePanel />,
    "runtime-configuration": () => <RuntimeConfigurationPanel />,
    "audio-registry": () => (
        <ConfigurationPlaceholderPanel
            title="Audio Registry"
            subtitle="Future stage — audio asset mapping only"
            detail="Client audio event → asset registry will be managed here. Playback stays presentation-only; server remains referee."
        />
    )
});

function renderSection(sectionId) {

    const render = SECTION_PANEL_RENDERERS[sectionId];

    return render ? render() : <ServerHealthPanel />;

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
