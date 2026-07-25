import { useConsoleConnectionStatus } from "./ConsoleStreamProvider";
import { CONSOLE_CONNECTION_STATES } from "./consoleSocketEvents";

/**
 * R6.0D — Namespace connection badge (CONNECTED / RECONNECTING / DISCONNECTED).
 */
export default function ConsoleConnectionStatus() {

    const { connectionState, connected, socketId } = useConsoleConnectionStatus();

    const label = connectionState
        || CONSOLE_CONNECTION_STATES.DISCONNECTED;

    const toneClass = connected
        ? "devConsole__connection--connected"
        : label === CONSOLE_CONNECTION_STATES.RECONNECTING
            ? "devConsole__connection--reconnecting"
            : "devConsole__connection--disconnected";

    return (

        <div
            className={`devConsole__connection ${toneClass}`}
            role="status"
            aria-live="polite"
            aria-label={`Console stream ${label}`}
        >

            <span className="devConsole__connectionDot" aria-hidden="true" />

            <span className="devConsole__connectionLabel">

                {label}

            </span>

            {socketId && (

                <span className="devConsole__connectionMeta">

                    {socketId.slice(0, 8)}

                </span>

            )}

        </div>

    );

}
