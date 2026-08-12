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
 * YYYY-MM-DD_ROOM_xxx_GAME_xxx_LIFECYCLE_ARCHIVE.zip
 */
export function buildForensicArchiveFilename({
    roomId,
    gameId = null,
    finishedAt = Date.now()
} = {}) {

    const stamp = formatArchiveDateStamp(finishedAt);
    const room = safeFilenameSegment(roomId);
    const game = gameId
        ? `GAME_${safeFilenameSegment(gameId)}`
        : "NO_GAME";

    return `${stamp}_ROOM_${room}_${game}_LIFECYCLE_ARCHIVE.zip`;

}
