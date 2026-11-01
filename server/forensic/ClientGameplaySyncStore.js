/**
 * Observation-only, bounded Page5/READY telemetry held until the one room ZIP is built.
 * Financial and gameplay state never consult this store.
 */
const MAX_ROOMS = 128;
const MAX_EVENTS_PER_PLAYER = 240;
const MAX_BATCH_EVENTS = 32;
const MAX_EVENT_BYTES = 550;
const MAX_BATCH_BYTES = 14000;
const RETENTION_MS = 3 * 60 * 60 * 1000;
const ALLOWED_FIELDS = new Set([
    "kind", "phase", "displayedPhase", "clockLabel", "clockValue",
    "serverTimestamp", "sequence", "receiveMs", "applyMs", "renderMs",
    "buttonState", "buttonEnabled", "buttonLocked", "readyConfirmed",
    "connected", "reason", "wheelAngle", "pointerAngle", "build",
    "recordedAt"
]);
const rooms = new Map();

function scalar(value) {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "string") return value.slice(0, 80);
    return null;
}

function prune(now) {
    for (const [id, room] of rooms) {
        if (now - room.updatedAt > RETENTION_MS) rooms.delete(id);
    }
    while (rooms.size > MAX_ROOMS) rooms.delete(rooms.keys().next().value);
}

function safeId(value) {
    return (typeof value === "string" || typeof value === "number")
        ? String(value).slice(0, 100) : null;
}

/**
 * The caller MUST supply identities from the authenticated socket binding.
 * rawBatch is untrusted and is never used for any gameplay decision.
 */
export function recordClientGameplaySyncBatch({
    roomId, gameId, playerId, rawBatch, now = Date.now()
} = {}) {
    const roomKey = safeId(roomId);
    const playerKey = safeId(playerId);
    const gameKey = safeId(gameId);
    if (!roomKey || !playerKey || !gameKey || !rawBatch || typeof rawBatch !== "object") {
        return { ok: false, reason: "INVALID_BINDING" };
    }
    if (!Array.isArray(rawBatch.events) || rawBatch.events.length > MAX_BATCH_EVENTS) {
        return { ok: false, reason: "INVALID_EVENTS" };
    }
    if (JSON.stringify(rawBatch).length > MAX_BATCH_BYTES) {
        return { ok: false, reason: "BATCH_TOO_LARGE" };
    }
    const batchId = safeId(rawBatch.batchId);
    const clientSession = safeId(rawBatch.clientSession);
    if (!batchId || !clientSession || !/^[a-zA-Z0-9_.-]+$/.test(batchId)
        || !/^[a-zA-Z0-9_.-]+$/.test(clientSession)) {
        return { ok: false, reason: "INVALID_BATCH_ID" };
    }

    prune(now);
    let room = rooms.get(roomKey);
    if (room && room.gameId !== gameKey) {
        return { ok: false, reason: "GAME_MISMATCH" };
    }
    if (!room) {
        room = { gameId: gameKey, updatedAt: now, players: new Map() };
        rooms.set(roomKey, room);
    }
    let player = room.players.get(playerKey);
    if (!player) {
        if (room.players.size >= 3) return { ok: false, reason: "PLAYER_LIMIT" };
        player = { events: [], batches: new Set(), droppedSamples: 0, droppedImportant: 0 };
        room.players.set(playerKey, player);
    }
    const dedupKey = clientSession + ":" + batchId;
    if (player.batches.has(dedupKey)) {
        return { ok: true, duplicate: true, accepted: 0 };
    }
    const events = [];
    for (const raw of rawBatch.events) {
        if (!raw || typeof raw !== "object" || typeof raw.kind !== "string") continue;
        const clean = {};
        for (const key of ALLOWED_FIELDS) {
            if (Object.hasOwn(raw, key)) clean[key] = scalar(raw[key]);
        }
        if (JSON.stringify(clean).length <= MAX_EVENT_BYTES) {
            events.push({ ...clean, serverReceivedAt: now });
        }
    }
    player.events.push(...events);
    if (player.events.length > MAX_EVENTS_PER_PLAYER) {
        player.events.splice(0, player.events.length - MAX_EVENTS_PER_PLAYER);
    }
    player.droppedSamples += Number.isInteger(rawBatch.droppedSamples)
        ? Math.min(100000, Math.max(0, rawBatch.droppedSamples)) : 0;
    player.droppedImportant += Number.isInteger(rawBatch.droppedImportant)
        ? Math.min(100000, Math.max(0, rawBatch.droppedImportant)) : 0;
    player.batches.add(dedupKey);
    if (player.batches.size > 300) player.batches.delete(player.batches.values().next().value);
    room.updatedAt = now;
    return { ok: true, duplicate: false, accepted: events.length };
}

export function getClientGameplaySyncSnapshot(roomId, gameId = null) {
    const room = rooms.get(String(roomId));
    if (!room || (gameId && room.gameId !== String(gameId))) {
        return { schemaVersion: 1, roomId, gameId: gameId ?? null, players: {}, observed: false };
    }
    const players = {};
    for (const [playerId, player] of room.players) {
        players[playerId] = {
            events: player.events.map(event => ({ ...event })),
            droppedSamples: player.droppedSamples,
            droppedImportant: player.droppedImportant
        };
    }
    return { schemaVersion: 1, roomId, gameId: room.gameId, players, observed: true };
}

export function resetClientGameplaySyncStoreForTests() {
    rooms.clear();
}
