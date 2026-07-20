import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { ReadyPhaseBroadcaster } from "../gameplay/ReadyPhaseBroadcaster.js";
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

const configurationEngine = {
    getConfiguration(gameId) {

        if (gameId !== "game-ready") {

            return null;

        }

        return {
            sectors: [
                { sectorId: "s0", ownerId: "p1", color: "#ff0000", icon: "A" }
            ],
            wheel: { startAngle: 42 },
            triangle: { startAngle: 17 }
        };

    }
};

const broadcaster = new ReadyPhaseBroadcaster({
    logger,
    eventBus,
    configurationEngine,
    devMode: false
});

broadcaster.initialize();

const events = [];

eventBus.subscribe(EVENT_TYPES.WHEEL_CONFIGURATION, (envelope) => {

    events.push(envelope.payload);

});

broadcaster._handleReadyStarted({
    gameId: "game-ready",
    phase: "READY"
});

assert(events.length === 1, "WHEEL_CONFIGURATION should emit once");

assert(events[0].wheelAngle === 42, "wheelAngle must come from configuration");

assert(events[0].triangleAngle === 17, "triangleAngle must come from configuration");

broadcaster._handleReadyStarted({
    gameId: "game-ready",
    phase: "READY"
});

assert(events.length === 1, "WHEEL_CONFIGURATION must broadcast only once per game");

broadcaster.shutdown();

logger.info("readyPhase.broadcaster.test.js: all assertions passed");
