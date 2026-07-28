/**
 * R6.1 / R6.2 — Audit helpers for developer auth (audit channel when available).
 * Never logs passwords or raw tokens.
 */

import { LOG_LEVELS } from "../../logging/levels.js";
import { LoggingManager } from "../../logging/LoggingManager.js";
import { DEVELOPER_ROLES } from "./developerRoles.js";

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

            const event = fields.role === DEVELOPER_ROLES.VIEWER
                ? "viewer login"
                : "administrator login";

            emit(LOG_LEVELS.INFO, event, fields);

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

        },
        permissionDenied(fields) {

            emit(LOG_LEVELS.WARN, "dashboard permission denial", fields);

        },
        environmentSwitch(fields) {

            const event = fields.to === "MAINNET"
                ? "mainnet activation"
                : "environment switch";

            emit(LOG_LEVELS.INFO, event, fields);

        },
        environmentSwitchFailed(fields) {

            emit(LOG_LEVELS.WARN, "environment switch failed", fields);

        },
        passwordConfirmation(fields) {

            emit(LOG_LEVELS.INFO, "password confirmation", fields);

        },
        enableMainnetConfirmation(fields) {

            emit(LOG_LEVELS.INFO, "ENABLE MAINNET confirmation", fields);

        },
        understandConfirmation(fields) {

            emit(LOG_LEVELS.INFO, "I UNDERSTAND confirmation", fields);

        },
        configurationChange(fields) {

            emit(LOG_LEVELS.INFO, "configuration change", fields);

        }
    };

}
