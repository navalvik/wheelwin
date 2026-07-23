import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { ResultSessionLifecycle } from "../gameplay/ResultSessionLifecycle.js";
import { LoggerService } from "../services/LoggerService.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

function wait(ms) {

    return new Promise((resolve) => setTimeout(resolve, ms));

}

const logger = new LoggerService({ logLevel: "error" });

logger.initialize();

const eventBus = new EventBus({
    logger,
    eventBusConfig: { logEvents: false, showDebugPanel: false }
});

eventBus.initialize();

const lifecycle = new ResultSessionLifecycle({
    logger,
    eventBus,
    roomConfig: { resultSessionDurationMs: 40 },
    devMode: false
});

lifecycle.initialize();

{
    const expired = [];

    eventBus.subscribe(EVENT_TYPES.RESULT_SESSION_EXPIRED, (envelope) => {

        expired.push(envelope.payload);

    });

    const session = lifecycle.start("room-a", { gameId: "game-a" });

    assert(session, "start must return a session");

    assert(lifecycle.isActive("room-a"), "session must be active");

    assert(
        session.expiresAt === session.startedAt + 40,
        "expiresAt must equal startedAt + duration"
    );

    await wait(70);

    assert(expired.length === 1, "RESULT_SESSION_EXPIRED must emit once");

    assert(expired[0].roomId === "room-a", "expired roomId must match");

    assert(expired[0].gameId === "game-a", "expired gameId must match");

    assert(
        expired[0].reason === "result_session_expired",
        "expired reason must be result_session_expired"
    );

    assert(!lifecycle.isActive("room-a"), "session cleared after expiry");

}

{
    const expired = [];

    eventBus.subscribe(EVENT_TYPES.RESULT_SESSION_EXPIRED, (envelope) => {

        expired.push(envelope.payload);

    });

    lifecycle.start("room-b", { gameId: "game-b" });

    assert(lifecycle.isActive("room-b"), "session B active");

    lifecycle.cancel("room-b");

    assert(!lifecycle.isActive("room-b"), "cancel clears session");

    await wait(70);

    assert(expired.length === 0, "cancel must prevent RESULT_SESSION_EXPIRED");

}

{
    lifecycle.start("room-c", { gameId: "game-c" });

    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.ROOM_DESTROYED,
        payload: { roomId: "room-c" }
    });

    assert(
        !lifecycle.isActive("room-c"),
        "ROOM_DESTROYED must cancel the result session timer"
    );

}

lifecycle.shutdown();

eventBus.shutdown();

console.log("resultSession.lifecycle.test.js: all assertions passed");
