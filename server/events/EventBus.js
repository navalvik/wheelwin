import { EventDispatcher } from "./EventDispatcher.js";
import { createEventId, createTraceId } from "./EventIdGenerator.js";

export class EventBus {

    constructor({ logger, eventBusConfig }) {

        this._logger = logger;

        this._config = eventBusConfig;

        this._dispatcher = new EventDispatcher({ logger });

        this._initialized = false;

        this._activeTraceId = null;

        this._lastEnvelope = null;

        this._lastSubscriberCount = 0;

    }

    initialize() {

        this._initialized = true;

    }

    shutdown() {

        this.clear();

        this._activeTraceId = null;

        this._lastEnvelope = null;

        this._lastSubscriberCount = 0;

        this._initialized = false;

    }

    subscribe(event, handler) {

        this._dispatcher.subscribe(event, handler);

    }

    unsubscribe(event, handler) {

        this._dispatcher.unsubscribe(event, handler);

    }

    once(event, handler) {

        this._dispatcher.once(event, handler);

    }

    clear() {

        this._dispatcher.clear();

    }

    hasSubscribers(event) {

        return this._dispatcher.hasSubscribers(event);

    }

    emit({ source, type, payload = null, traceId }) {

        if (!source) {

            throw new Error("Event source is required");

        }

        if (!type) {

            throw new Error("Event type is required");

        }

        const resolvedTraceId = traceId ?? this._activeTraceId ?? createTraceId();

        const envelope = this._createEnvelope({
            source,
            type,
            payload,
            traceId: resolvedTraceId
        });

        this._lastEnvelope = envelope;

        const subscriberCount = this._dispatcher.getSubscriberCount(type);

        this._lastSubscriberCount = subscriberCount;

        const startedAt = this._config.logEvents ? performance.now() : 0;

        if (this._config.logEvents) {

            this._logEmitStart(envelope, subscriberCount);

        }

        const previousTraceId = this._activeTraceId;

        this._activeTraceId = envelope.traceId;

        try {

            this._dispatcher.dispatch(envelope);

        } finally {

            this._activeTraceId = previousTraceId;

        }

        if (this._config.logEvents) {

            const elapsedMs = (performance.now() - startedAt).toFixed(2);

            this._logger.info("Completed");
            this._logger.info(`Execution Time: ${elapsedMs}ms`);
            this._logger.info("");

        }

    }

    getDebugSnapshot() {

        return {
            registeredEvents: this._dispatcher.getRegisteredEvents(),
            lastEventId: this._lastEnvelope?.eventId ?? null,
            lastTraceId: this._lastEnvelope?.traceId ?? null,
            lastSource: this._lastEnvelope?.source ?? null,
            lastType: this._lastEnvelope?.type ?? null,
            lastTimestamp: this._lastEnvelope?.timestamp ?? null,
            lastSubscriberCount: this._lastSubscriberCount
        };

    }

    _createEnvelope({ source, type, payload, traceId }) {

        const safePayload = this._copyPayload(payload);

        const envelope = {
            eventId: createEventId(),
            traceId,
            source,
            type,
            timestamp: Date.now(),
            payload: safePayload
        };

        return Object.freeze(envelope);

    }

    _copyPayload(payload) {

        if (payload === null || payload === undefined) {

            return payload;

        }

        if (Array.isArray(payload)) {

            if (Object.isFrozen(payload)) {

                return payload;

            }

            return Object.freeze([...payload]);

        }

        if (typeof payload === "object") {

            if (Object.isFrozen(payload)) {

                return payload;

            }

            return Object.freeze({ ...payload });

        }

        return payload;

    }

    _logEmitStart(envelope, subscriberCount) {

        this._logger.info("");
        this._logger.info("[EventBus]");
        this._logger.info("");
        this._logger.info("Event:");
        this._logger.info(envelope.eventId);
        this._logger.info("");
        this._logger.info("Trace:");
        this._logger.info(envelope.traceId);
        this._logger.info("");
        this._logger.info("Source:");
        this._logger.info(envelope.source);
        this._logger.info("");
        this._logger.info("Type:");
        this._logger.info(envelope.type);
        this._logger.info("");
        this._logger.info("Subscribers:");
        this._logger.info(String(subscriberCount));

    }

}
