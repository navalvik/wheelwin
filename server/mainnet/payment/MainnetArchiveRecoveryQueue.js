/** Select durable Mainnet outcomes for the existing shared forensic archiver. */
export function listMainnetArchiveCandidates(financialLedger) {
    if (typeof financialLedger?.listClosedRooms !== "function"
        || typeof financialLedger?.listPayouts !== "function") {
        throw new Error("MAINNET_ARCHIVE_LEDGER_INVALID");
    }

    const byRoom = new Map();
    for (const closed of financialLedger.listClosedRooms()) {
        if (typeof closed?.roomId !== "string" || !closed.roomId) continue;
        byRoom.set(closed.roomId, Object.freeze({
            roomId: closed.roomId,
            reason: closed.closureReason
        }));
    }
    for (const payout of financialLedger.listPayouts()) {
        if (typeof payout?.roomId !== "string" || !payout.roomId || byRoom.has(payout.roomId)) continue;
        // Payout plans are candidates even while pending. The unchanged shared
        // finality gate decides whether the archive can actually be published.
        byRoom.set(payout.roomId, Object.freeze({
            roomId: payout.roomId,
            reason: "game_completed"
        }));
    }
    return Object.freeze([...byRoom.values()]);
}

/** Return a bounded, rotating batch so one held archive cannot starve others. */
export function selectMainnetArchiveBatch(candidates, cursor = 0, limit = 3) {
    if (!Array.isArray(candidates) || !Number.isSafeInteger(cursor)
        || !Number.isSafeInteger(limit) || limit < 0) {
        throw new Error("MAINNET_ARCHIVE_BATCH_INVALID");
    }
    if (candidates.length === 0 || limit === 0) {
        return Object.freeze({ items: Object.freeze([]), nextCursor: 0 });
    }
    const start = ((cursor % candidates.length) + candidates.length) % candidates.length;
    const count = Math.min(limit, candidates.length);
    const items = Array.from({ length: count }, (_, index) => candidates[(start + index) % candidates.length]);
    return Object.freeze({ items: Object.freeze(items), nextCursor: (start + count) % candidates.length });
}
