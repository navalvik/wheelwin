export class EventDispatcher {

    constructor({ logger }) {

        this._logger = logger;

        this._subscribers = new Map();

    }

    subscribe(event, handler) {

        let handlers = this._subscribers.get(event);

        if (!handlers) {

            handlers = [];

            this._subscribers.set(event, handlers);

        }

        handlers.push(handler);

    }

    unsubscribe(event, handler) {

        const handlers = this._subscribers.get(event);

        if (!handlers) {

            return;

        }

        const index = handlers.indexOf(handler);

        if (index === -1) {

            return;

        }

        handlers.splice(index, 1);

        if (handlers.length === 0) {

            this._subscribers.delete(event);

        }

    }

    once(event, handler) {

        const wrapper = (envelope) => {

            this.unsubscribe(event, wrapper);

            handler(envelope);

        };

        this.subscribe(event, wrapper);

    }

    clear() {

        this._subscribers.clear();

    }

    hasSubscribers(event) {

        const handlers = this._subscribers.get(event);

        return Boolean(handlers && handlers.length > 0);

    }

    getSubscriberCount(event) {

        const handlers = this._subscribers.get(event);

        return handlers ? handlers.length : 0;

    }

    getRegisteredEvents() {

        const entries = [];

        for (const [event, handlers] of this._subscribers) {

            entries.push({
                event,
                subscriberCount: handlers.length
            });

        }

        return entries;

    }

    dispatch(envelope) {

        const handlers = this._subscribers.get(envelope.type);

        if (!handlers || handlers.length === 0) {

            return 0;

        }

        // A local snapshot is required for correctness: event handlers may emit
        // other events synchronously (re-entrant dispatch). A shared buffer would
        // be mutated by the nested dispatch and corrupt this iteration.
        const snapshot = handlers.slice();

        for (let index = 0; index < snapshot.length; index += 1) {

            const handler = snapshot[index];

            const subscriberLabel = handler.name || `subscriber#${index + 1}`;

            try {

                handler(envelope);

            } catch (error) {

                this._logger.error(
                    [
                        "Event subscriber failed",
                        `eventId=${envelope.eventId}`,
                        `traceId=${envelope.traceId}`,
                        `source=${envelope.source}`,
                        `type=${envelope.type}`,
                        `subscriber=${subscriberLabel}`
                    ].join(" | "),
                    error
                );

            }

        }

        return snapshot.length;

    }

}
