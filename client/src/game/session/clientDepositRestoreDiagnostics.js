/**
 * R18-S16 — Logging-only Page4 Deposit restore diagnostics.
 * Observes received/applied projection fields. Does not invent fallbacks.
 */

const FIELD_ORDER = [
    "roomId",
    "playerId",
    "depositId",
    "depositAddress",
    "state",
    "confirmedSeats",
    "mySeatStatus",
    "deployValueNanotons"
];

export function formatClientDepositRestoreLog(event, fields = {}) {

    const parts = [`[R18-S16 ClientDepositRestore] event=${event}`];

    for (const key of FIELD_ORDER) {

        const value = fields[key];

        if (value === undefined || value === null || value === "") {

            continue;

        }

        parts.push(`${key}=${value}`);

    }

    return parts.join(" | ");

}

export function logClientDepositRestore(event, fields = {}) {

    console.info(formatClientDepositRestoreLog(event, fields));

}
