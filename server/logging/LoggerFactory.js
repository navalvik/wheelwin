/**
 * R7.0D — Creates channel loggers bound to LoggingManager.
 */

import { LOG_CHANNELS, LOG_LEVELS } from "./levels.js";
import { LogCorrelation } from "./LogCorrelation.js";

export class BoundLogger {

    /**
     * @param {{
     *   manager: import("./LoggingManager.js").LoggingManager,
     *   channel: string,
     *   service: string,
     *   baseFields?: object
     * }} options
     */
    constructor({ manager, channel, service, baseFields = {} }) {

        this._manager = manager;

        this._channel = channel;

        this._service = service;

        this._baseFields = baseFields;

    }

    child(fields) {

        return new BoundLogger({
            manager: this._manager,
            channel: this._channel,
            service: this._service,
            baseFields: { ...this._baseFields, ...fields }
        });

    }

    trace(message, fields) {

        this._write(LOG_LEVELS.TRACE, message, fields);

    }

    debug(message, fields) {

        this._write(LOG_LEVELS.DEBUG, message, fields);

    }

    info(message, fields) {

        this._write(LOG_LEVELS.INFO, message, fields);

    }

    warn(message, fields) {

        this._write(LOG_LEVELS.WARN, message, fields);

    }

    error(message, errorOrFields = null, maybeFields = null) {

        let error = null;

        let fields = maybeFields;

        if (errorOrFields && typeof errorOrFields === "object"
            && (errorOrFields instanceof Error || errorOrFields.stack)) {

            error = errorOrFields;

        } else if (errorOrFields && typeof errorOrFields === "object") {

            fields = errorOrFields;

        }

        this._write(LOG_LEVELS.ERROR, message, fields, error);

    }

    fatal(message, errorOrFields = null, maybeFields = null) {

        let error = null;

        let fields = maybeFields;

        if (errorOrFields && typeof errorOrFields === "object"
            && (errorOrFields instanceof Error || errorOrFields.stack)) {

            error = errorOrFields;

        } else if (errorOrFields && typeof errorOrFields === "object") {

            fields = errorOrFields;

        }

        this._write(LOG_LEVELS.FATAL, message, fields, error);

    }

    /**
     * Compatibility with legacy LoggerService.startupLine.
     */
    startupLine(label) {

        this.info(`${label} OK`);

    }

    /**
     * R7.20C — Architectural decision trace via LoggingManager.
     */
    decisionTrace(params) {

        this._manager.decisionTrace({
            ...params,
            roomId: params?.roomId ?? this._baseFields.roomId ?? null,
            gameId: params?.gameId ?? this._baseFields.gameId ?? null
        });

    }

    _write(level, message, fields = null, error = null) {

        this._manager.write({
            level,
            channel: this._channel,
            service: this._service,
            message,
            fields: { ...this._baseFields, ...(fields || {}) },
            error
        });

    }

}

export class LoggerFactory {

    /**
     * @param {import("./LoggingManager.js").LoggingManager} manager
     */
    constructor(manager) {

        this._manager = manager;

    }

    create(service = "wheelwin-server", fields = {}) {

        return new BoundLogger({
            manager: this._manager,
            channel: LOG_CHANNELS.APPLICATION,
            service,
            baseFields: fields
        });

    }

    createAudit(service = "wheelwin-audit", fields = {}) {

        return new BoundLogger({
            manager: this._manager,
            channel: LOG_CHANNELS.AUDIT,
            service,
            baseFields: fields
        });

    }

    /**
     * Run fn under correlated context; returns a child logger for convenience.
     */
    withCorrelation(context, fn) {

        return LogCorrelation.withContext(context, () => {

            const logger = this.create("wheelwin-server", context);

            return fn(logger);

        });

    }

}
