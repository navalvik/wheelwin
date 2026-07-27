/**
 * R6.2B — Download the current room's diagnostic log from /console.
 */

import { getConsoleApiBase } from "./developerAuthApi.js";

export function buildRoomDiagnosticLogUrl(roomId) {

    if (!roomId) {

        return null;

    }

    return `${getConsoleApiBase()}/console/rooms/${encodeURIComponent(roomId)}/diagnostic-log`;

}

/**
 * Native download via hidden iframe (same pattern as game report).
 */
export function downloadRoomDiagnosticLog(roomId, accessToken = null) {

    const url = buildRoomDiagnosticLogUrl(roomId);

    if (!url || typeof document === "undefined") {

        return false;

    }

    // Auth-enabled consoles need the bearer token; use fetch→blob when present.
    if (accessToken) {

        fetch(url, {
            headers: {
                Authorization: `Bearer ${accessToken}`
            }
        })
            .then(async (response) => {

                if (!response.ok) {

                    throw new Error(`Diagnostic download failed (${response.status})`);

                }

                const disposition = response.headers.get("Content-Disposition")
                    ?? "";

                const match = /filename="([^"]+)"/.exec(disposition);

                const filename = match?.[1] ?? `ROOM_${roomId}.log`;

                const blob = await response.blob();

                const objectUrl = URL.createObjectURL(blob);

                const anchor = document.createElement("a");

                anchor.href = objectUrl;

                anchor.download = filename;

                document.body.appendChild(anchor);

                anchor.click();

                anchor.remove();

                URL.revokeObjectURL(objectUrl);

            })
            .catch(() => {
                // Surface nothing into gameplay; console user can retry.
            });

        return true;

    }

    const frame = document.createElement("iframe");

    frame.style.display = "none";

    frame.src = url;

    document.body.appendChild(frame);

    setTimeout(() => {

        frame.remove();

    }, 60_000);

    return true;

}
