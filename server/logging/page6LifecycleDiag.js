/**
 * R12.5E — Page6 / Result Session lifecycle diagnostics (server).
 * Observation only. Does not change lifecycle semantics.
 */

const PREFIX = "[R12.5E Page6]";

export function page6LifecycleDiag(logger, event, fields = {}) {

    const payload = {
        event,
        ts: Date.now(),
        ...sanitizeServerPage6DiagFields(fields)
    };

    const line = `${PREFIX} ${event} | ${formatDiagFields(payload)}`;

    if (logger && typeof logger.info === "function") {

        logger.info(line);

    } else {

        console.info(line);

    }

    return payload;

}

export function sanitizeServerPage6DiagFields(fields = {}) {

    const out = {};

    for (const [key, value] of Object.entries(fields)) {

        if (value === undefined) {

            continue;

        }

        if (
            key === "wallet"
            || key === "mnemonic"
            || key === "privateKey"
            || key === "token"
            || key === "accessToken"
            || key === "refreshToken"
        ) {

            continue;

        }

        out[key] = value;

    }

    return out;

}

function formatDiagFields(fields) {

    return Object.entries(fields)
        .filter(([key]) => key !== "event")
        .map(([key, value]) => `${key}=${value === null ? "null" : String(value)}`)
        .join(" | ");

}
