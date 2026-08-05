/**
 * R7.0D — Application logger facade (compatible with pre-R7.0D call sites).
 *
 * Delegates to LoggingManager. Prefer LoggingManager / LoggerFactory for new code.
 */

import { EVENT_TYPES } from "../events/EventTypes.js";
import { LoggingManager } from "../logging/LoggingManager.js";
import { LOG_LEVELS } from "../logging/levels.js";

export { LOG_LEVELS };

export class LoggerService {

    constructor({
        logLevel = LOG_LEVELS.INFO,
        loggingManager = null,
        service = "wheelwin-server"
    } = {}) {

        this._initialized = false;

        this._eventBus = null;

        this._testEventHandler = null;

        this._manager = loggingManager || LoggingManager.getInstance();

        this._service = service;

        this._requestedLevel = logLevel;

        this._bound = null;

    }

    initialize() {

        if (!this._manager.isInitialized()) {

            this._manager.initialize({
                level: this._requestedLevel,
                enableConsole: true,
                enableFile: false,
                format: "console"
            });

        } else {

            this._manager.setMinimumLevel(this._requestedLevel);

        }

        this._bound = this._manager.getFactory().create(this._service);

        this._initialized = true;

    }

    connectEventBus(eventBus) {

        this._eventBus = eventBus;

        this._testEventHandler = (envelope) => {

            this.debug(
                `LoggerService received event: ${envelope.type} (${envelope.eventId})`
            );

        };

        eventBus.subscribe(EVENT_TYPES.TEST_EVENT, this._testEventHandler);

    }

    disconnectEventBus() {

        if (this._eventBus && this._testEventHandler) {

            this._eventBus.unsubscribe(
                EVENT_TYPES.TEST_EVENT,
                this._testEventHandler
            );

        }

        this._eventBus = null;

        this._testEventHandler = null;

    }

    shutdown() {

        this.disconnectEventBus();

        this._initialized = false;

    }

    setLogLevel(logLevel) {

        this._requestedLevel = logLevel;

        this._manager.setMinimumLevel(logLevel);

    }

    trace(message, fields) {

        this._ensureBound().trace(message, fields);

    }

    debug(message, fields) {

        this._ensureBound().debug(message, fields);

    }

    info(message, fields) {

        this._ensureBound().info(message, fields);

    }

    warn(message, fields) {

        this._ensureBound().warn(message, fields);

    }

    error(message, error = null, fields = null) {

        this._ensureBound().error(message, error, fields);

    }

    fatal(message, error = null, fields = null) {

        this._ensureBound().fatal(message, error, fields);

    }

    startupLine(label) {

        this._ensureBound().startupLine(label);

    }

    /**
     * R7.20C — Architectural decision trace (Developer Log + Railway).
     */
    decisionTrace(params) {

        this._manager.decisionTrace(params);

    }

    child(fields) {

        return this._ensureBound().child(fields);

    }

    _ensureBound() {

        if (!this._bound) {

            if (!this._manager.isInitialized()) {

                this._manager.initialize({
                    level: this._requestedLevel,
                    enableConsole: true,
                    enableFile: false,
                    format: "console"
                });

            }

            this._bound = this._manager.getFactory().create(this._service);

        }

        return this._bound;

    }

}
