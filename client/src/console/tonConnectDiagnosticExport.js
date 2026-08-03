/**
 * R6.8 / R6.11C / R6.11E — Client-side read-only export of TonConnect diagnostics
 * for the currently selected room (no backend mutation).
 */

import { downloadTonConnectAutopsyJson } from "../diagnostics/tonConnectAutopsy";

function buildFilename(roomId, filterLabel) {

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const room = String(roomId ?? "room").slice(0, 24);
    const filter = filterLabel ? `_${filterLabel}` : "";

    return `tonconnect_${room}${filter}_${stamp}.json`;

}

export function downloadTonConnectDiagnostics({
    roomId,
    filter = "all",
    timeframeMs = null,
    sinceAt = null,
    payload
}) {

    if (!payload || typeof document === "undefined") {

        return false;

    }

    const envelope = {
        exportedAt: new Date().toISOString(),
        roomId: roomId ?? payload.roomId ?? null,
        filter,
        timeframeMs,
        sinceAt,
        diagnostics: payload
    };

    const blob = new Blob(
        [JSON.stringify(envelope, null, 2)],
        { type: "application/json" }
    );

    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");

    anchor.href = objectUrl;
    anchor.download = buildFilename(envelope.roomId, filter);
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(objectUrl);

    return true;

}

/**
 * R6.11E — download server autopsy from room diagnostics (not window object).
 */
export function downloadTonConnectAutopsy(serverAutopsy = null, meta = {}) {

    return downloadTonConnectAutopsyJson(serverAutopsy, meta);

}

export function shortenWallet(value, head = 6, tail = 4) {

    if (typeof value !== "string" || !value) {

        return "—";

    }

    if (value.length <= head + tail + 1) {

        return value;

    }

    return `${value.slice(0, head)}…${value.slice(-tail)}`;

}

export function formatDiagnosticTime(at) {

    if (!at) {

        return "—";

    }

    try {

        return new Date(at).toLocaleTimeString();

    } catch {

        return String(at);

    }

}
