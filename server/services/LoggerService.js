import { LOG_LEVELS } from "../config/production.js";
import { EVENT_TYPES } from "../events/EventTypes.js";

const LEVEL_PRIORITY = Object.freeze({
    [LOG_LEVELS.ERROR]: 0,
    [LOG_LEVELS.WARN]: 1,
    [LOG_LEVELS.INFO]: 2,
    [LOG_LEVELS.DEBUG]: 3
});

export class LoggerService {

    constructor({ logLevel = LOG_LEVELS.INFO } = {}) {

        this._initialized = false;

        this._eventBus = null;

        this._testEventHandler = null;

        this._minLevel = LEVEL_PRIORITY[logLevel] ?? LEVEL_PRIORITY[LOG_LEVELS.INFO];

    }

    initialize() {

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

        this._minLevel = LEVEL_PRIORITY[logLevel] ?? this._minLevel;

    }

    debug(message) {

        this._write(LOG_LEVELS.DEBUG, message, process.stdout);

    }

    info(message) {

        this._write(LOG_LEVELS.INFO, message, process.stdout);

    }

    warn(message) {

        this._write(LOG_LEVELS.WARN, message, process.stderr);

    }

    error(message, error = null) {

        this._write(LOG_LEVELS.ERROR, message, process.stderr);

        if (error?.stack) {

            process.stderr.write(`${error.stack}\n`);

        }

    }

    startupLine(label) {

        process.stdout.write(`${label} OK\n`);

    }

    _write(level, message, stream) {

        if ((LEVEL_PRIORITY[level] ?? LEVEL_PRIORITY[LOG_LEVELS.INFO]) > this._minLevel) {

            return;

        }

        stream.write(`${message}\n`);

    }

}
