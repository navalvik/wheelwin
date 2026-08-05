/**
 * R7.11A — Temporary destroy forensics (diagnostics only).
 * Callers register context immediately before RoomManager.destroyRoom().
 */

const _pendingByRoom = new Map();

/**
 * @param {string} roomId
 * @param {object} context
 */
export function registerRoomDestroyContext(roomId, context = {}) {

    if (!roomId) {

        return;

    }

    _pendingByRoom.set(roomId, {
        ...context,
        registeredAt: Date.now()
    });

}

/**
 * @param {string} roomId
 * @returns {object|null}
 */
export function consumeRoomDestroyContext(roomId) {

    if (!roomId) {

        return null;

    }

    const context = _pendingByRoom.get(roomId) ?? null;

    _pendingByRoom.delete(roomId);

    return context;

}
