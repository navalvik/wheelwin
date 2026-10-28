// At 50 occupied Page4 rooms the average provider load is 50/12≈4.17 RPS.
// A separate global burst ceiling prevents all 50 rooms from hitting Toncenter
// simultaneously (e.g. when all rooms come online in the same second).
// No wallet catalog scans, interval timers, or background tasks.
export const ACTIVE_ROOM_OBSERVATION_INTERVAL_MS = 12_000;
export const ACTIVE_ROOM_MAX_OBSERVATIONS_PER_SECOND = 6;

export class ActiveRoomObservationBudget {
    constructor({
        intervalMs = ACTIVE_ROOM_OBSERVATION_INTERVAL_MS,
        maxPerSecond = ACTIVE_ROOM_MAX_OBSERVATIONS_PER_SECOND
    } = {}) {
        if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000)
            throw new TypeError("invalid observation interval");
        if (!Number.isSafeInteger(maxPerSecond) || maxPerSecond < 1)
            throw new TypeError("invalid global observation ceiling");
        this._interval = intervalMs;
        this._maxPerSecond = maxPerSecond;
        this._last = new Map();
        this._recentProviderCalls = [];
    }
    claim(roomId, nowMs = Date.now()) {
        if (typeof roomId !== "string" || roomId.length === 0
            || !Number.isSafeInteger(nowMs) || nowMs < 0) return false;
        const last = this._last.get(roomId);
        if (last !== undefined && (nowMs < last
            || nowMs - last < this._interval)) return false;

        // Sliding window, not wall-clock buckets: six requests at
        // 12:00:00.999 cannot be followed by six at 12:00:01.000.
        this._recentProviderCalls = this._recentProviderCalls.filter(
            startedAt => nowMs >= startedAt && nowMs - startedAt < 1000
        );
        if (this._recentProviderCalls.length >= this._maxPerSecond)
            return false;
        // Only successful reservations consume room cadence or provider budget.
        this._recentProviderCalls.push(nowMs);
        this._last.set(roomId, nowMs);
        return true;
    }
    forget(roomId) { this._last.delete(roomId); }
}
