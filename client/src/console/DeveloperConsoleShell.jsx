import { useEffect } from "react";

import { Link } from "react-router-dom";

import ConsoleLayout from "./ConsoleLayout";
import DeveloperLoginPanel from "./DeveloperLoginPanel";
import ConsoleReadOnlyBadge from "./ConsoleReadOnlyBadge";
import ConsoleConnectionStatus from "./ConsoleConnectionStatus";
import { useDeveloperAuth } from "./DeveloperAuthProvider";

/**
 * R6.0E / R6.1 — Developer Console chrome with secure session controls.
 */
export default function DeveloperConsoleShell({
    activeSectionId,
    onSelectSection,
    children
}) {

    const { session, environment, requiresLogin } = useDeveloperAuth();

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

                        {!requiresLogin && <ConsoleConnectionStatus />}

                        {!requiresLogin && session && (

                            <div className="devConsole__sessionChip" role="status">

                                <span>

                                    {session.username}

                                </span>

                                <span>

                                    {session.role}

                                </span>

                                <span>

                                    {environment}

                                </span>

                            </div>

                        )}

                    </div>

                </div>

                <div className="devConsole__headerActions">

                    <DeveloperLoginPanel />

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
