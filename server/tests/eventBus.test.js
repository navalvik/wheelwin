import { EventBus } from "../events/EventBus.js";
import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { LoggerService } from "../services/LoggerService.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

const logger = new LoggerService();

logger.initialize();

const eventBus = new EventBus({
    logger,
    eventBusConfig: { logEvents: false, showDebugPanel: false }
});

eventBus.initialize();

const received = [];

eventBus.subscribe(EVENT_TYPES.TEST_EVENT, (envelope) => {

    received.push(envelope.type);

});

eventBus.subscribe(EVENT_TYPES.TEST_EVENT, () => {

    throw new Error("subscriber failure");

});

eventBus.subscribe(EVENT_TYPES.TEST_EVENT, (envelope) => {

    received.push(envelope.payload.label);

});

eventBus.emit({
    source: EVENT_SOURCES.APPLICATION,
    type: EVENT_TYPES.TEST_EVENT,
    payload: { label: "unit_test" }
});

assert(received.length === 2, "remaining subscribers should still run");

assert(received[0] === EVENT_TYPES.TEST_EVENT, "first subscriber should receive event");

assert(received[1] === "unit_test", "third subscriber should receive payload");

const childEvents = [];

eventBus.subscribe(EVENT_TYPES.GAME_STARTED, (envelope) => {

    childEvents.push(envelope.traceId);

});

eventBus.subscribe(EVENT_TYPES.TEST_EVENT, (parentEnvelope) => {

    eventBus.emit({
        source: EVENT_SOURCES.GAME_MANAGER,
        type: EVENT_TYPES.GAME_STARTED,
        payload: { propagated: true }
    });

    childEvents.push(parentEnvelope.traceId);

});

const parentTraceId = "trace_parent_chain";

eventBus.emit({
    source: EVENT_SOURCES.SOCKET_GATEWAY,
    type: EVENT_TYPES.TEST_EVENT,
    payload: { label: "parent" },
    traceId: parentTraceId
});

assert(childEvents.length === 2, "parent and child events should be emitted");

assert(
    childEvents[0] === parentTraceId,
    "child event should inherit parent traceId"
);

assert(
    childEvents[1] === parentTraceId,
    "parent handler should receive parent traceId"
);

const snapshot = eventBus.getDebugSnapshot();

assert(snapshot.lastEventId, "debug snapshot should include last event id");

assert(snapshot.lastTraceId === parentTraceId, "debug snapshot should include trace id");

assert(snapshot.lastSource === EVENT_SOURCES.GAME_MANAGER, "debug snapshot should include source");

assert(snapshot.lastType === EVENT_TYPES.GAME_STARTED, "debug snapshot should include type");

eventBus.clear();

assert(
    eventBus.getDebugSnapshot().registeredEvents.length === 0,
    "clear should remove all subscribers"
);

logger.info("EventBus tests passed");
