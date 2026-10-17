/**
 * RoomDestroyContextRegistry — recovery forensics for authoritative room
 * destruction (financial-free, game-recovery infra only).
 *
 * Producers call registerRoomDestroyContext() immediately before requesting a
 * room destroy; RoomManager.destroyRoom() consumes (pops) the context so the
 * destroy decision trace records the authoritative lifecycle stage, caller and
 * trigger event. Entries are single-shot and capped to avoid unbounded growth.
 */

const MAX_PENDING_CONTEXTS = 512;

const contexts = new Map();

export function registerRoomDestroyContext(roomId, context) {

    if (!roomId) {

        return;

    }

    if (contexts.size >= MAX_PENDING_CONTEXTS) {

        const oldestKey = contexts.keys().next().value;

        if (oldestKey !== undefined) {

            contexts.delete(oldestKey);

        }

    }

    contexts.set(String(roomId), Object.freeze({ ...(context ?? {}) }));

}

export function consumeRoomDestroyContext(roomId) {

    if (!roomId) {

        return null;

    }

    const context = contexts.get(String(roomId)) ?? null;

    if (context) {

        contexts.delete(String(roomId));

    }

    return context;

}