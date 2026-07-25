/**
 * R6.1 / R7.0D — Audit helpers for developer auth (audit channel when available).
 * Never logs passwords or raw tokens.
 */

import { LOG_LEVELS } from "../../logging/levels.js";
import { LoggingManager } from "../../logging/LoggingManager.js";

export function createDeveloperAuthAudit(logger) {

    function emit(level, message, fields = {}) {

        const manager = LoggingManager.getInstance();

        if (manager.isInitialized()) {

            manager.audit(message, {
                component: "DeveloperAuth",
                ...fields
            }, level);

            return;

        }

        const parts = ["[DeveloperAuth]", message];

        for (const [key, value] of Object.entries(fields)) {

            if (value === undefined || value === null || value === "") {

                continue;

            }

            parts.push(`${key}=${value}`);

        }

        const text = parts.join(" | ");

        if (level === LOG_LEVELS.WARN && logger?.warn) {

            logger.warn(text);

            return;

        }

        if (level === LOG_LEVELS.ERROR && logger?.error) {

            logger.error(text);

            return;

        }

        logger?.info?.(text);

    }

    return {
        loginSuccess(fields) {

            emit(LOG_LEVELS.INFO, "login success", fields);

        },
        loginFailed(fields) {

            emit(LOG_LEVELS.WARN, "login failed", fields);

        },
        logout(fields) {

            emit(LOG_LEVELS.INFO, "logout", fields);

        },
        refreshSuccess(fields) {

            emit(LOG_LEVELS.INFO, "session renewed", fields);

        },
        refreshFailed(fields) {

            emit(LOG_LEVELS.WARN, "refresh failed", fields);

        },
        unauthorized(fields) {

            emit(LOG_LEVELS.WARN, "unauthorized", fields);

        },
        socketRejected(fields) {

            emit(LOG_LEVELS.WARN, "socket rejected", fields);

        }
    };

}
