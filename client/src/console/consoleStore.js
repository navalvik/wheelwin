/**
 * R6.0D / R6.0E — Console stream store (mirror of gateway pushes + UI views).
 */

import { CONSOLE_CONNECTION_STATES } from "./consoleSocketEvents";

export const CONSOLE_LOG_BUFFER_SIZE = 500;

export const CONSOLE_TIMELINE_BUFFER_SIZE = 200;

export const CONSOLE_STORE_INITIAL_STATE = Object.freeze({
    connectionState: CONSOLE_CONNECTION_STATES.DISCONNECTED,
    connected: false,
    socketId: null,
    subscribed: false,
    focus: Object.freeze({ roomId: null, gameId: null }),
    server: null,
    rooms: null,
    room: null,
    game: null,
    players: null,
    payments: null,
    recovery: null,
    simulation: null,
    metrics: null,
    logs: Object.freeze([]),
    timeline: Object.freeze([]),
    lastEnvelopeAt: null,
    // R6.1 — Developer Login session (not implemented).
    developerSession: null
});

export function createConsoleStoreState(overrides = {}) {

    return {
        ...CONSOLE_STORE_INITIAL_STATE,
        ...overrides,
        focus: Object.freeze({
            ...CONSOLE_STORE_INITIAL_STATE.focus,
            ...(overrides.focus ?? {})
        }),
        logs: Object.freeze([...(overrides.logs ?? [])]),
        timeline: Object.freeze([...(overrides.timeline ?? [])])
    };

}

export function appendConsoleLog(logs, entry) {

    const next = [...logs, entry];

    if (next.length > CONSOLE_LOG_BUFFER_SIZE) {

        next.splice(0, next.length - CONSOLE_LOG_BUFFER_SIZE);

    }

    return Object.freeze(next);

}

export function appendTimelineEntries(timeline, entries) {

    if (!entries?.length) {

        return timeline;

    }

    const next = [...entries, ...timeline];

    if (next.length > CONSOLE_TIMELINE_BUFFER_SIZE) {

        next.length = CONSOLE_TIMELINE_BUFFER_SIZE;

    }

    return Object.freeze(next);

}

/**
 * Diff rooms index into chronological timeline entries (newest first).
 */
export function diffRoomsTimeline(previousRooms, nextRooms, at = Date.now()) {

    const prevMap = new Map(
        (previousRooms ?? []).map((room) => [room.roomId, room])
    );
    const nextMap = new Map(
        (nextRooms ?? []).map((room) => [room.roomId, room])
    );

    const entries = [];

    for (const [roomId, room] of nextMap) {

        const previous = prevMap.get(roomId);

        if (!previous) {

            entries.push(Object.freeze({
                at,
                kind: "ROOM_CREATED",
                roomId,
                gameId: room.gameId ?? null,
                summary: `Room created · ${room.state ?? "unknown"}`
            }));

            continue;

        }

        if (previous.state !== room.state
            || previous.setupState !== room.setupState
            || previous.gameId !== room.gameId
            || previous.playerCount !== room.playerCount) {

            entries.push(Object.freeze({
                at,
                kind: "ROOM_UPDATED",
                roomId,
                gameId: room.gameId ?? null,
                summary: [
                    room.state,
                    `players=${room.playerCount ?? 0}`,
                    room.setupState ? `setup=${room.setupState}` : null,
                    room.gameId ? `game=${room.gameId}` : null
                ].filter(Boolean).join(" · ")
            }));

        }

    }

    for (const [roomId, room] of prevMap) {

        if (!nextMap.has(roomId)) {

            entries.push(Object.freeze({
                at,
                kind: "ROOM_REMOVED",
                roomId,
                gameId: room.gameId ?? null,
                summary: "Room removed"
            }));

        }

    }

    return entries;

}
