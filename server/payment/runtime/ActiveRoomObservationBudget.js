// One chain observation per active Page4 room per 12 seconds.
// For 50 active rooms this caps the steady-state discovery rate at
// 50/12 ≈ 4.17 requests per second, below the 8 RPS provider limiter.
// No timer, global 64-wallet scanner, or background task.
export const ACTIVE_ROOM_OBSERVATION_INTERVAL_MS = 12_000;

export class ActiveRoomObservationBudget {
    constructor({intervalMs = ACTIVE_ROOM_OBSERVATION_INTERVAL_MS} = {}) {
        if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000)
            throw new TypeError("invalid observation interval");
        this._interval = intervalMs;
        this._last = new Map();
    }
    claim(roomId, nowMs = Date.now()) {
        if (typeof roomId !== "string" || roomId.length === 0
            || !Number.isSafeInteger(nowMs) || nowMs < 0) return false;
        const last = this._last.get(roomId);
        if (last !== undefined && nowMs >= last && nowMs - last < this._interval)
            return false;
        this._last.set(roomId, nowMs);
        return true;
    }
    forget(roomId) { this._last.delete(roomId); }
}
