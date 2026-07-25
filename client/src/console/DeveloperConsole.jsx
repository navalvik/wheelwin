import { useCallback, useState } from "react";

import DeveloperConsoleShell from "./DeveloperConsoleShell";
import ConsolePlaceholderPanel from "./panels/ConsolePlaceholderPanel";
import {
    DEFAULT_CONSOLE_SECTION_ID,
    getConsoleSection
} from "./consoleSections";

/**
 * R6.0B — WheelWin Developer Console root composition.
 *
 * Foundation only: navigation + placeholders.
 * No projections, APIs, or live streams in this stage.
 */
export default function DeveloperConsole() {

    const [activeSectionId, setActiveSectionId] = useState(
        DEFAULT_CONSOLE_SECTION_ID
    );

    const onSelectSection = useCallback((sectionId) => {

        setActiveSectionId(sectionId);

    }, []);

    const section = getConsoleSection(activeSectionId);

    return (

        <DeveloperConsoleShell
            activeSectionId={activeSectionId}
            onSelectSection={onSelectSection}
        >

            <ConsolePlaceholderPanel
                title={section.label}
                reserved={section.reserved === true}
            />

        </DeveloperConsoleShell>

    );

}
