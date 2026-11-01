/**
 * Auto-submit one sanitized, locally recorded Page5 report after Page6 mounts.
 * Best-effort diagnostics: no influence on result, payouts or room timers.
 *
 * Use the already-authenticated PAGE6_CLIENT_DIAG socket channel; the server
 * binds room/game/player to the live Telegram player socket.
 */
import { LOBBY_OUTGOING_EVENTS } from "../../socket/socketEvents.js";

export function createPage5AutoReportSender({
    socket,
    reportProvider,
    roomId,
    gameId,
    playerId,
    onStatus = () => {},
    schedule = (fn, ms) => setInterval(fn, ms),
    unschedule = id => clearInterval(id)
}) {
    let disposed = false;
    let acknowledged = false;
    let busy = false;
    let lastStatusAt = 0;
    let intervalId = null;
    const identity = { roomId, gameId, playerId };

    function status(text) {
        if (!disposed) onStatus(text);
    }

    function send(event, data, callback) {
        if (!socket?.connected || typeof socket?.emit !== "function") return false;
        try {
            if (typeof socket.timeout === "function") {
                socket.timeout(4000).emit(
                    LOBBY_OUTGOING_EVENTS.PAGE6_CLIENT_DIAG,
                    {event, ...identity, ...data}, callback
                );
            } else {
                socket.emit(
                    LOBBY_OUTGOING_EVENTS.PAGE6_CLIENT_DIAG,
                    {event, ...identity, ...data}, callback
                );
            }
            return true;
        } catch {
            return false;
        }
    }

    function updateArchiveStatus(now = Date.now()) {
        if (busy || !acknowledged || now - lastStatusAt < 4500) return;
        lastStatusAt = now;
        busy = true;
        if (!send("PAGE5_DEVICE_REPORT_STATUS", {}, (err, result) => {
            busy = false;
            if (disposed) return;
            // Socket timeout callbacks use (error,response). The fake socket
            // in tests also follows that exact ack convention.
            if (err || result?.ok !== true) return;
            if (result.uploaded === true) {
                status("R2 ARCHIVE UPLOADED: " + (result.archiveFilename ?? "COMPLETED.zip"));
            } else {
                status("PAGE5 REPORT RECEIVED BY SERVER ("
                    + (result.received ?? "?") + "/3). Waiting for final R2 ZIP.");
            }
        })) busy = false;
    }

    function tick() {
        if (disposed || busy || !socket?.connected) return;
        if (acknowledged) {
            updateArchiveStatus();
            return;
        }
        const report=reportProvider?.();
        if (!report || report.roomId !== roomId
            || report.gameId !== gameId || report.playerId !== playerId) {
            status("Waiting for this player's local Page5 diagnostics.");
            return;
        }
        busy = true;
        if (!send("PAGE5_DEVICE_REPORT", {report}, (err, result) => {
            busy = false;
            if (disposed) return;
            if (!err && result?.ok === true) {
                acknowledged = true;
                status("PAGE5 REPORT RECEIVED BY SERVER ("
                    + (result.received ?? "?") + "/3).");
                updateArchiveStatus();
            } else if (result?.reason === "ARCHIVE_ALREADY_FINAL") {
                acknowledged = true;
                status("R2 archive already finalized. Local report not added.");
            } else {
                status("Page5 report upload pending. Retrying automatically.");
            }
        })) {
            busy = false;
            status("Page5 report upload pending. Retrying automatically.");
        }
    }

    function start() {
        if (intervalId !== null) return;
        socket?.on?.("connect", tick);
        intervalId = schedule(tick, 4000);
        tick();
    }
    function dispose() {
        if (disposed) return;
        disposed = true;
        socket?.off?.("connect", tick);
        if (intervalId !== null) unschedule(intervalId);
        intervalId = null;
    }

    return {
        start,
        dispose,
        tick,
        getStatus() {return {disposed,acknowledged,busy};}
    };
}
