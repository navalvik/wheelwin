import { useEffect } from "react";

import { Link } from "react-router-dom";

import ConsoleLayout from "./ConsoleLayout";
import ConsoleLoginPlaceholder from "./ConsoleLoginPlaceholder";
import ConsoleReadOnlyBadge from "./ConsoleReadOnlyBadge";
import ConsoleConnectionStatus from "./ConsoleConnectionStatus";

/**
 * R6.0B / R6.0D — Developer Console chrome (header, badge, stream status, login slot).
 */
export default function DeveloperConsoleShell({
    activeSectionId,
    onSelectSection,
    children
}) {

    useEffect(() => {

        const previousTitle = document.title;

        document.title = "WheelWin Developer Console";

        return () => {

            document.title = previousTitle;

        };

    }, []);

    return (

        <div className="devConsole">

            <header className="devConsole__header">

                <div className="devConsole__headerPrimary">

                    <h1 className="devConsole__title">

                        WheelWin Developer Console

                    </h1>

                    <p className="devConsole__subtitle">

                        Operational monitoring for the WheelWin server.
                        Read-only. Not part of gameplay.

                    </p>

                    <div className="devConsole__statusRow">

                        <ConsoleReadOnlyBadge />

                        <ConsoleConnectionStatus />

                    </div>

                </div>

                <div className="devConsole__headerActions">

                    <ConsoleLoginPlaceholder />

                    <Link className="devConsole__backLink" to="/">

                        Back to game flow

                    </Link>

                </div>

            </header>

            <ConsoleLayout
                activeSectionId={activeSectionId}
                onSelectSection={onSelectSection}
            >

                {children}

            </ConsoleLayout>

        </div>

    );

}
