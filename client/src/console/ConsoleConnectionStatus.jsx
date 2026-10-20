import { useEffect, useState } from "react";
import { useConsoleConnectionStatus } from "./ConsoleStreamProvider";
import { CONSOLE_CONNECTION_STATES } from "./consoleSocketEvents";

const STALE_AFTER_MS = 15000;

function timestamp(value) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "string" || !value.trim()) return null;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
}

export default function ConsoleConnectionStatus() {
    const { connectionState, connected, socketId, lastEnvelopeAt } = useConsoleConnectionStatus();
    const [now, setNow] = useState(Date.now);

    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, []);

    const label = connectionState || CONSOLE_CONNECTION_STATES.DISCONNECTED;
    const lastAt = timestamp(lastEnvelopeAt);
    const age = lastAt === null ? null : Math.max(0, now - lastAt);
    const stale = connected && (age === null || age > STALE_AFTER_MS);
    const toneClass = stale
        ? "devConsole__connection--reconnecting"
        : connected
            ? "devConsole__connection--connected"
            : label === CONSOLE_CONNECTION_STATES.RECONNECTING
                ? "devConsole__connection--reconnecting"
                : "devConsole__connection--disconnected";
    const freshness = age === null
        ? "NO SERVER DATA"
        : age < 1000
            ? "UPDATED JUST NOW"
            : "UPDATED " + Math.floor(age / 1000) + "s AGO";

    return (
        <div
            className={"devConsole__connection " + toneClass}
            role="status"
            aria-live="polite"
            aria-label={stale ? "Console transport " + label + "; server data stale" : "Console stream " + label + "; " + freshness}
        >
            <span className="devConsole__connectionDot" aria-hidden="true" />
            <span className="devConsole__connectionLabel">{stale ? "STALE DATA" : label}</span>
            <span className="devConsole__connectionMeta">{freshness}</span>
            {socketId && <span className="devConsole__connectionMeta">{socketId.slice(0, 8)}</span>}
        </div>
    );
}
