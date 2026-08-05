const R711B_TRACED_EVENTS = new Set([
    "GAME_CONTRACT_DEPLOY_FAILED",
    "GAME_CONTRACT_DEPLOYED",
    "PAYMENT_SESSION_FAILED",
    "GAME_CONTRACT_READY_FOR_PAYMENTS",
    "PAYMENT_CONNECTION_READY"
]);

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

            if (R711B_TRACED_EVENTS.has(envelope.type)) {

                console.log("======================================================");
                console.log("EVENT DISPATCH — NO SUBSCRIBERS");
                console.log("======================================================");
                console.log("EventName:", envelope.type);
                console.log("Timestamp:", new Date(envelope.timestamp).toISOString());
                console.log("======================================================");

            }

            return 0;

        }

        if (R711B_TRACED_EVENTS.has(envelope.type)) {

            console.log("======================================================");
            console.log("EVENT DISPATCH START");
            console.log("======================================================");
            console.log("EventName:", envelope.type);
            console.log("SubscriberCount:", handlers.length);
            console.log("Timestamp:", new Date(envelope.timestamp).toISOString());
            console.log("======================================================");

        }

        // A local snapshot is required for correctness: event handlers may emit
        // other events synchronously (re-entrant dispatch). A shared buffer would
        // be mutated by the nested dispatch and corrupt this iteration.
        const snapshot = handlers.slice();

        for (let index = 0; index < snapshot.length; index += 1) {

            const handler = snapshot[index];

            const subscriberLabel = handler.name || `subscriber#${index + 1}`;

            const subscriberStartedAt = Date.now();

            if (R711B_TRACED_EVENTS.has(envelope.type)) {

                console.log("======================================================");
                console.log("SUBSCRIBER EXECUTING");
                console.log("======================================================");
                console.log("EventName:", envelope.type);
                console.log("SubscriberName:", subscriberLabel);
                console.log("ExecutionOrder:", index + 1);
                console.log("Timestamp:", new Date(subscriberStartedAt).toISOString());
                console.log("======================================================");

            }

            try {

                handler(envelope);

                if (R711B_TRACED_EVENTS.has(envelope.type)) {

                    console.log("======================================================");
                    console.log("SUBSCRIBER COMPLETED");
                    console.log("======================================================");
                    console.log("EventName:", envelope.type);
                    console.log("SubscriberName:", subscriberLabel);
                    console.log("ExecutionOrder:", index + 1);
                    console.log("ReturnedNormally:", true);
                    console.log("DurationMs:", Date.now() - subscriberStartedAt);
                    console.log("NextSubscriber:", snapshot[index + 1]?.name
                        ?? (index + 1 < snapshot.length
                            ? `subscriber#${index + 2}`
                            : "(none)"));
                    console.log("======================================================");

                }

            } catch (error) {

                if (R711B_TRACED_EVENTS.has(envelope.type)) {

                    console.log("======================================================");
                    console.log("SUBSCRIBER EXCEPTION");
                    console.log("======================================================");
                    console.log("EventName:", envelope.type);
                    console.log("SubscriberName:", subscriberLabel);
                    console.log("ExecutionOrder:", index + 1);
                    console.log("Error.name:", error?.name ?? "unknown");
                    console.log("Error.message:", error?.message ?? String(error));
                    console.log("Error.stack:", error?.stack ?? null);
                    console.log("NextSubscriber:", snapshot[index + 1]?.name
                        ?? (index + 1 < snapshot.length
                            ? `subscriber#${index + 2}`
                            : "(none)"));
                    console.log("======================================================");

                }

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

        if (R711B_TRACED_EVENTS.has(envelope.type)) {

            console.log("======================================================");
            console.log("EVENT DISPATCH COMPLETE");
            console.log("======================================================");
            console.log("EventName:", envelope.type);
            console.log("SubscribersExecuted:", snapshot.length);
            console.log("Timestamp:", new Date().toISOString());
            console.log("======================================================");

        }

        return snapshot.length;

    }

}
