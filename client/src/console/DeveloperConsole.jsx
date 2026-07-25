import { useCallback, useEffect, useState } from "react";

import DeveloperConsoleShell from "./DeveloperConsoleShell";
import {
    ConsoleStreamProvider,
    useConsoleFocus
} from "./ConsoleStreamProvider";
import { getConsoleSection } from "./consoleSections";
import {
    readRememberedSectionId,
    rememberSectionId
} from "./sectionMemory";

import ServerHealthPanel from "./panels/ServerHealthPanel";
import RoomsExplorerPanel from "./panels/RoomsExplorerPanel";
import GameDetailPanel from "./panels/GameDetailPanel";
import PlayersInspectorPanel from "./panels/PlayersInspectorPanel";
import PaymentsPanel from "./panels/PaymentsPanel";
import RecoveryPanel from "./panels/RecoveryPanel";
import SimulationPanel from "./panels/SimulationPanel";
import EventBusPanel from "./panels/EventBusPanel";
import MetricsPanel from "./panels/MetricsPanel";
import TimelinePanel from "./panels/TimelinePanel";
import DeveloperLogPanel from "./panels/DeveloperLogPanel";
import SettingsPanel from "./panels/SettingsPanel";

function renderSection(sectionId) {

    switch (sectionId) {

        case "server-health":
            return <ServerHealthPanel />;

        case "rooms":
            return <RoomsExplorerPanel />;

        case "games":
            return <GameDetailPanel />;

        case "players":
            return <PlayersInspectorPanel />;

        case "payments":
            return <PaymentsPanel />;

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

        default:
            return <ServerHealthPanel />;

    }

}

/**
 * R6.0E — Console body: persistent nav + operational panels.
 */
function DeveloperConsoleBody() {

    const [activeSectionId, setActiveSectionId] = useState(
        () => readRememberedSectionId()
    );

    const { setFocus } = useConsoleFocus();

    const onSelectSection = useCallback((sectionId) => {

        const next = getConsoleSection(sectionId).id;

        setActiveSectionId(next);

        rememberSectionId(next);

        // Clear focus when leaving detail-capable sections.
        if (next !== "rooms" && next !== "games") {

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

            {renderSection(activeSectionId)}

        </DeveloperConsoleShell>

    );

}

/**
 * WheelWin Developer Console root.
 */
export default function DeveloperConsole() {

    return (

        <ConsoleStreamProvider>

            <DeveloperConsoleBody />

        </ConsoleStreamProvider>

    );

}
