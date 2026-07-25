/**
 * R6.1 — Audit helpers for developer login/logout (LoggerService only).
 * Never logs passwords or raw tokens.
 */

export function createDeveloperAuthAudit(logger) {

    function line(level, message, fields = {}) {

        const parts = ["[DeveloperAuth]", message];

        for (const [key, value] of Object.entries(fields)) {

            if (value === undefined || value === null || value === "") {

                continue;

            }

            parts.push(`${key}=${value}`);

        }

        const text = parts.join(" | ");

        if (level === "warn" && logger?.warn) {

            logger.warn(text);

            return;

        }

        if (level === "error" && logger?.error) {

            logger.error(text);

            return;

        }

        logger?.info?.(text);

    }

    return {
        loginSuccess(fields) {

            line("info", "login success", fields);

        },
        loginFailed(fields) {

            line("warn", "login failed", fields);

        },
        logout(fields) {

            line("info", "logout", fields);

        },
        refreshSuccess(fields) {

            line("info", "session renewed", fields);

        },
        refreshFailed(fields) {

            line("warn", "refresh failed", fields);

        },
        unauthorized(fields) {

            line("warn", "unauthorized", fields);

        },
        socketRejected(fields) {

            line("warn", "socket rejected", fields);

        }
    };

}
