function pad(value, size = 2) {

    return String(value).padStart(size, "0");

}

export function safeFilenameSegment(value) {

    return String(value ?? "unknown").replace(/[^\w.-]+/g, "_");

}

export function formatArchiveDateStamp(ms = Date.now()) {

    const date = new Date(ms);

    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}`
        + `-${pad(date.getUTCDate())}`;

}

/**
 * Normalize session-history lifecycleResult / close reason into archive filename suffix.
 *
 * GAME_COMPLETED → COMPLETED
 * ROOM_DESTROYED → ROOM_DESTROYED
 * other terminal outcomes → FAILED
 */
export function resolveArchiveFilenameResult({
    lifecycleResult = null,
    reason = null
} = {}) {

    const candidates = [
        lifecycleResult,
        reason
    ]
        .filter((value) => value != null && String(value).trim() !== "")
        .map((value) => String(value).trim().toUpperCase().replace(/[\s-]+/g, "_"));

    for (const candidate of candidates) {

        if (
            candidate === "COMPLETED"
            || candidate === "GAME_COMPLETED"
            || candidate === "RESULT_SESSION_FINISHED"
            || candidate === "SESSION_ENDED"
        ) {

            return "COMPLETED";

        }

        if (
            candidate === "ROOM_DESTROYED"
            || candidate === "ROOM_DESTROY"
        ) {

            return "ROOM_DESTROYED";

        }

        if (candidate === "FAILED" || candidate.endsWith("_FAILED")) {

            return "FAILED";

        }

        if (
            candidate.includes("TIMEOUT")
            || candidate.includes("ABORT")
            || candidate.includes("EXPIRED")
            || candidate.includes("ERROR")
            || candidate.includes("CANCEL")
        ) {

            return "FAILED";

        }

    }

    const lowerReason = String(reason ?? "").toLowerCase();

    if (
        lowerReason.includes("finish")
        || lowerReason.includes("page6")
        || lowerReason.includes("session_ended")
        || lowerReason.includes("game_completed")
        || lowerReason === "completed"
    ) {

        return "COMPLETED";

    }

    if (
        lowerReason.includes("timeout")
        || lowerReason.includes("fail")
        || lowerReason.includes("abort")
        || lowerReason.includes("expired")
        || lowerReason.includes("creator_left")
        || lowerReason.includes("payment")
        || lowerReason.includes("tonconnect")
        || lowerReason.includes("wallet")
        || lowerReason.includes("verify")
        || lowerReason.includes("recovery")
        || lowerReason.includes("game_start")
    ) {

        return "FAILED";

    }

    if (
        lowerReason.includes("room_destroyed")
        || lowerReason.includes("room_close")
        || lowerReason === "room_destroyed"
        || lowerReason === ""
    ) {

        return "ROOM_DESTROYED";

    }

    return "ROOM_DESTROYED";

}

/**
 * YYYY-MM-DD_ROOM_xxx_GAME_xxx_<RESULT>.zip
 * RESULT ∈ { COMPLETED, ROOM_DESTROYED, FAILED }
 */
export function buildForensicArchiveFilename({
    roomId,
    gameId = null,
    finishedAt = Date.now(),
    lifecycleResult = null,
    reason = null
} = {}) {

    const stamp = formatArchiveDateStamp(finishedAt);
    const room = safeFilenameSegment(roomId);
    const game = gameId
        ? `GAME_${safeFilenameSegment(gameId)}`
        : "NO_GAME";
    const result = resolveArchiveFilenameResult({
        lifecycleResult,
        reason
    });

    return `${stamp}_ROOM_${room}_${game}_${result}.zip`;

}
