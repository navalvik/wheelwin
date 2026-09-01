/**
 * R18-S16 — Logging-only formatter for protected Deposit restore.
 * Does not read or derive Deposit state. Callers pass already-authoritative fields.
 */

export function formatDepositRestoreLog({
    event,
    roomId = null,
    playerId = null,
    socketId = null,
    reason = null,
    restored = undefined,
    depositAddress = undefined,
    state = undefined,
    confirmedSeats = undefined,
    mySeatStatus = undefined
} = {}) {

    const parts = [
        `[R18-S16 DepositRestore] event=${event}`,
        `roomId=${roomId ?? "null"}`,
        `playerId=${playerId ?? "null"}`,
        `socketId=${socketId ?? "null"}`,
        `reason=${reason ?? "null"}`
    ];

    if (restored !== undefined) {

        parts.push(`restored=${restored === true ? "true" : "false"}`);

    }

    if (depositAddress !== undefined) {

        parts.push(`depositAddress=${depositAddress ?? "null"}`);

    }

    if (state !== undefined) {

        parts.push(`state=${state ?? "null"}`);

    }

    if (confirmedSeats !== undefined) {

        parts.push(`confirmedSeats=${confirmedSeats ?? "null"}`);

    }

    if (mySeatStatus !== undefined) {

        parts.push(`mySeatStatus=${mySeatStatus ?? "null"}`);

    }

    return parts.join(" | ");

}
